import type { RpcStub } from "cloudflare:workers";
import { ActionDescriptionBuilder } from "@gadgets/gatekeeper-kit/action-description";
import { ActionJournal, defineActions, type ActionSubmitter, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import type { GitCache } from "@gadgets/workshop-shared/gatekeeper";
import type { AzureClient } from "./azure-client";
import { publishAzurePullRequest } from "./azure-publication";
import type { BranchProps } from "./branch";
import type { AzurePublication, AzurePullRequestProposal } from "./types";

type Proposal = {head: string; title: string; description: string; sourceRefName: string; requestKey: string};
type Actions = {publish: Proposal};
type Host = {
  props: BranchProps;
  publish(proposal: Proposal, cache: RpcStub<GitCache>): Promise<void>;
  reject(proposal: Proposal): void;
};

const actions = defineActions<Host, Actions>({
  publish: {
    kind: {tag: "publishPullRequest", label: "Publish a branch and open a pull request"},
    autoApprovable: false,
    delivery: "await-decision",
    describe(proposal, {props}) {
      const presentation = new ActionDescriptionBuilder(
        "Create a branch at the reviewed commit and open a pull request into the attached Azure Repos branch.",
      ).inline("Project", props.project).inline("Repository", props.repository)
        .inline("Source branch", proposal.sourceRefName).inline("Target branch", props.refName)
        .inline("Base commit", props.commitId).inline("Commit to publish", proposal.head)
        .inline("Pull request title", proposal.title).verbatim("Pull request description", proposal.description).finish();
      if (!presentation.descriptionIsComplete) throw new Error("The pull request details are too large to review.");
      return {...presentation, title: "Publish Azure Repos pull request", implementsRevert: false,
        pushedCommits: [proposal.head], reviewPushFrom: props.commitId};
    },
    async apply(proposal, host, {gitCache}) {
      if (!gitCache) throw new Error("Publishing requires the approved commit's Git cache.");
      await host.publish(proposal, gitCache);
    },
    reject(proposal, host) { host.reject(proposal); return Promise.resolve(); },
  },
}, {fence: "authority", vendorId: "azure_repos"});

/** Owns the journal for one branch binding. The same account may renew its PAT before approval. */
export class BranchPublications {
  readonly #journal;
  readonly #actions;
  readonly #submissions = new SerialTaskQueue();
  constructor(private readonly storage: DurableObjectStorage, private readonly props: BranchProps,
              client: () => Promise<AzureClient>) {
    this.#journal = new ActionJournal<TaggedAction<Actions>>(storage.kv, {namespace: "azurePR"});
    this.#actions = actions.bind(this.#journal, {
      props,
      publish: async (proposal, cache) => {
        // Recheck the pinned identity and access with the current PAT immediately before dispatch.
        const api = await client();
        // Keep the ref even if the push succeeds but the PR request is interrupted. A renewed
        // proposal for these exact changes can pick up where the earlier approval stopped.
        storage.kv.put(proposal.requestKey, proposal.sourceRefName);
        const result = await publishAzurePullRequest(api, cache, {...props, ...proposal});
        storage.kv.put<AzurePublication>(proposal.sourceRefName, {
          ...this.#branches(proposal.sourceRefName), status: "published", ...result,
        });
      },
      reject: ({sourceRefName}) => {
        storage.kv.put<AzurePublication>(sourceRefName, {...this.#branches(sourceRefName), status: "rejected"});
      },
    });
  }

  #branches(sourceRefName: string): AzurePullRequestProposal {
    return {sourceRefName, targetRefName: this.props.refName};
  }

  async propose(queue: ActionSubmitter, head: string, title: string, description: string): Promise<AzurePullRequestProposal> {
    if (!/^[0-9a-f]{40}$/.test(head) || head === this.props.commitId) {
      throw new Error("Commit the worktree changes and pass the new full Git commit ID.");
    }
    if (!title.trim() || title.length > 400 || /[\r\n\0]/.test(title)) {
      throw new Error("Use a single-line pull request title of 1 to 400 characters.");
    }
    if (description.length > 4000 || description.includes("\0")) throw new Error("Use a pull request description of at most 4000 characters.");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([head, title, description])));
    const requestKey = "publicationRef:" + new Uint8Array(digest).toHex();
    return this.#submissions.run(async () => {
      const pending = this.#journal.listPending().find(entry => entry.action.payload.requestKey === requestKey);
      if (pending) return this.#branches(pending.action.payload.sourceRefName);
      const attempted = this.storage.kv.get<string>(requestKey);
      if (attempted && this.storage.kv.get<AzurePublication>(attempted)?.status === "published") return this.#branches(attempted);
      const sourceRefName = attempted ?? "refs/heads/agents/" + crypto.randomUUID();
      const proposal = {sourceRefName, head, title, description, requestKey};
      await this.#actions.submit(queue, "publish", proposal, {fence: {generation: this.props.userObjectId}});
      return this.#branches(sourceRefName);
    });
  }

  status(sourceRefName: string): AzurePublication {
    if (/^refs\/heads\/agents\/[0-9a-f-]{36}$/.test(sourceRefName)) {
      if (this.#journal.listPending().some(entry => entry.action.payload.sourceRefName === sourceRefName)) {
        return {...this.#branches(sourceRefName), status: "pending"};
      }
      const result = this.storage.kv.get<AzurePublication>(sourceRefName);
      if (result) return result;
    }
    throw new Error("Unknown Azure pull request proposal for this connection.");
  }

  apply(id: number, gitCache: RpcStub<GitCache>) {
    return this.#actions.apply(id, {gitCache, generation: this.props.userObjectId});
  }
  reject(id: number) { return this.#actions.reject(id); }
}
