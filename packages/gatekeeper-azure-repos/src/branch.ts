import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { formatSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, GitOid, GitPullHints,
  GitPullTransfer, ObservationDescription, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { type AzureVerifier, type Env } from "./azure-repos";
import { AzureClient } from "./azure-client";
import { BranchPublications } from "./branch-publications";
import type { BranchSelection } from "./resource-url";
import { pullAzureGit } from "./azure-git";
import type { AzurePublication, AzurePullRequestProposal, AzureReposBranch, AzureReposCheckout } from "./types";
import TYPES_CODE from "./generated/branch-types.txt";

export type PinnedBranch = BranchSelection & {collectionId: string};
export type BranchProps = PinnedBranch & {
  userObjectId: string; project: string; repository: string;
};

function pinOf({collectionId, projectId, repositoryId, refName, commitId}: PinnedBranch): PinnedBranch {
  return {collectionId, projectId, repositoryId, refName, commitId};
}

async function observationId(pin: PinnedBranch): Promise<string> {
  const fragments = [
    {name: "collection", id: pin.collectionId}, {name: "project", id: pin.projectId},
    {name: "repo", id: pin.repositoryId}, {name: "ref", id: pin.refName}, {name: "commit", id: pin.commitId},
  ];
  const id = formatSubresourceId({fragments});
  if (id.length <= 2048) return id;
  // Long Unicode refs can exceed the ledger's encoded-ID limit. The verifier still receives the exact ref.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin.refName));
  fragments[3] = {name: "ref-sha256", id: new Uint8Array(digest).toHex()};
  return formatSubresourceId({fragments});
}

function observe(queue: RpcStub<ApprovalQueue>, observation: ObservationDescription & {subresources: string[]}): Promise<void> {
  return queue.authorizeObservation(observation);
}

@validateRpc()
class BranchSession extends RpcTarget implements AzureReposBranch {
  #queue: RpcStub<ApprovalQueue>;
  #ctx: DurableObjectState<BranchProps>;
  #publications: BranchPublications;
  constructor(queue: RpcStub<ApprovalQueue>, ctx: DurableObjectState<BranchProps>, publications: BranchPublications) {
    super();
    this.#queue = queue;
    this.#ctx = ctx;
    this.#publications = publications;
  }
  [Symbol.dispose]() { this.#queue[Symbol.dispose](); }
  async #authorize(title: string, description: string, requireCurrentTip = false) {
    const props = this.#ctx.props;
    const account = this.#ctx.exports.UserAccount;
    await account.get(account.idFromString(props.userObjectId)).verifyPin(pinOf(props), requireCurrentTip);
    await observe(this.#queue, {
      title, description,
      subresources: [await observationId(props)],
    });
  }
  async getCheckout(): Promise<AzureReposCheckout> {
    await this.#authorize("Open Azure Repos revision", "Read the attached branch revision.");
    const props = this.#ctx.props;
    using cache = await this.#queue.getGitCache();
    await cache.advertiseCommit(props.commitId);
    return {project: props.project, repository: props.repository, refName: props.refName, commitId: props.commitId};
  }
  async proposePullRequest(commitId: string, title: string, description = ""): Promise<AzurePullRequestProposal> {
    await this.#authorize("Prepare Azure pull request", "Use the attached repository and target branch.", true);
    return this.#publications.propose(this.#queue, commitId, title, description);
  }
  async getPublication(sourceRefName: string): Promise<AzurePublication> {
    await this.#authorize("Read Azure publication status", "Read the outcome of a proposal made through this connection.");
    return this.#publications.status(sourceRefName);
  }
}

@validateRpc()
export class AzureBranchGatekeeper extends DurableObject<Env, BranchProps> implements Gatekeeper<AzureReposBranch> {
  #publications = new BranchPublications(this.ctx.storage, this.ctx.props, async () => {
    const props = this.ctx.props;
    const accounts = this.ctx.exports.UserAccount;
    const pat = await accounts.get(accounts.idFromString(props.userObjectId)).tokenForPin(pinOf(props));
    return new AzureClient(this.env, pat);
  });
  async describe(): Promise<ResourceDescription> {
    // Workshop uses this description to ask a prospective observer to choose an account, before
    // verifying their access. Its stored resource type identifies the binding during that step.
    return {
      url: "", title: "Azure Repos branch", snippet: "",
      suggestedBindingName: "AZURE_REPOS_BRANCH", tsType: "AzureReposBranch",
    };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<AzureReposBranch> {
    return new BranchSession(queue.dup(), this.ctx, this.#publications);
  }
  async gitPull(oids: GitOid[], hints: GitPullHints): Promise<GitPullTransfer> {
    const pin = pinOf(this.ctx.props);
    const accounts = this.ctx.exports.UserAccount;
    const account = accounts.get(accounts.idFromString(this.ctx.props.userObjectId));
    const pat = await account.tokenForPin(pin);
    return await pullAzureGit(this.env, pat, pin, oids, hints);
  }
  async verifyObserverAccess(
    observers: {id: string; verifier: Fetcher<GatekeeperUserVerifier>}[], subresources: string[],
  ): Promise<{allowedObserverIds: string[]}> {
    const pin = pinOf(this.ctx.props);
    const id = await observationId(pin);
    if (subresources.some(value => value !== id)) throw new Error("Unknown Azure Repos observation.");
    return await observerAccessVerifier<Fetcher<AzureVerifier>>({
      hasCollectionAccess: async (verifier, ids) => {
        const allowed = await verifier.hasPin(pin);
        return ids.map(() => allowed);
      },
    })(observers, subresources);
  }
  async getHistoricalSubresources(): Promise<string[]> { return []; }
  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
  async applyAction(id: number, cache: RpcStub<GitCache>): Promise<void> { await this.#publications.apply(id, cache); }
  async rejectAction(id: number): Promise<void> { await this.#publications.reject(id); }
  async revertAction(_id: number): Promise<void> { throw new Error("Manage a published pull request in Azure Repos."); }
}
