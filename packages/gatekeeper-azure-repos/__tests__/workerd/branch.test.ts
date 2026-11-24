import { SELF, runInDurableObject } from "cloudflare:test";
import { env, exports, RpcStub, RpcTarget } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { ApprovalQueue, GatekeeperConnectCallback, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { AzureBranchGatekeeper, BranchProps } from "../../src/branch";
import { collectionId, commitId, projectId, refName, repositoryId } from "./fake-azure";

const callback = () => (exports as typeof exports & {
  TestCallback(options: {props: Record<string, never>}): Fetcher<GatekeeperConnectCallback>;
}).TestCallback({props: {}});
const pin = {collectionId, commitId, projectId, refName, repositoryId};

async function submit(form: {action: string; nonce: string}, pat: string, origin = "http://localhost:8787") {
  const response = await SELF.fetch(form.action, {
    method: "POST", headers: {origin, "content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({nonce: form.nonce, pat}).toString(),
  });
  const text = await response.text();
  expect(text).not.toContain(pat);
  return {status: response.status, text};
}

async function open(link: string) {
  const response = await SELF.fetch(link);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const html = await response.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1];
  const action = /<form method="post" action="([^"]+)"/.exec(html)![1];
  return {nonce, action};
}

async function connect(pat: string) {
  const {url} = await exports.GatekeeperVendor.connectAccount(callback());
  const userObjectId = url.split("/").at(-2)!;
  const form = await open(url);
  const result = await submit(form, pat);
  expect(result.status).toBe(200);
  return {
    url, form, userObjectId,
    user: exports.AzureUser({props: {userObjectId}}),
    account: env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId)),
  };
}

it("requires the same-origin POST, returns a ticket and consumes both nonces", async () => {
  const {url} = await exports.GatekeeperVendor.connectAccount(callback());
  const form = await open(url);
  expect(form.action).toMatch(/\/connect$/);
  expect((await SELF.fetch(url)).status).toBe(400);
  expect((await submit(form, "test-owner-pat", "https://other.test")).status).toBe(403);
  expect((await submit(form, "rejected")).status).toBe(400);
  expect((await submit(form, "test-owner-pat")).text).toContain("connected");
  expect((await submit(form, "test-owner-pat")).status).toBe(400);
});

it("stages only a matching identity and commits only the ticket's own unexpired stage", async () => {
  const {user, account} = await connect("first-owner-pat");
  const selected = await account.confirmBranch(projectId, repositoryId, refName, commitId);
  const reconnect = async (pat: string) => submit(await open((await user.reconnect()).url), pat);
  expect((await reconnect("other")).status).toBeGreaterThanOrEqual(400);
  expect((await account.credentials()).pat).toBe("first-owner-pat");
  expect((await reconnect("second-owner-pat")).status).toBe(200);
  const stage = async () => runInDurableObject(account, (_, state) =>
    state.storage.kv.get<{stageId: string}>("stagedCredentials")!.stageId);
  const first = await stage();
  expect((await account.credentials()).pat).toBe("first-owner-pat");
  expect((await reconnect("third-owner-pat")).status).toBe(200);
  await expect(Promise.resolve(user.commitReconnect(first))).rejects.toThrow();
  const current = await stage();
  await user.commitReconnect(current);
  expect((await account.credentials()).pat).toBe("third-owner-pat");
  expect((await user.getGatekeeperClassFor(selected.resourceUrl!)).resource.id).toBe("branch");
  await expect(Promise.resolve(user.commitReconnect(current))).rejects.toThrow();
  await user.revoke();
  await expect(Promise.resolve(account.credentials())).rejects.toThrow();
});

class RecordingQueue extends RpcTarget {
  observations: ObservationDescription[] = [];
  commits: string[] = [];
  refuse = false;
  async authorizeObservation(observation: ObservationDescription) {
    this.observations.push(observation);
    if (this.refuse) throw new Error("Observation refused");
  }
  async getGitCache() {
    const commits = this.commits;
    return new class extends RpcTarget {async advertiseCommit(oid: string) {commits.push(oid);}}();
  }
}

it("keeps the observer setup description independent of the private Azure selection", async () => {
  const id = env.USER_ACCOUNT.newUniqueId();
  const description = await runInDurableObject(env.USER_ACCOUNT.get(id), async (_, state) => {
    const props: BranchProps = {
      ...pin, userObjectId: id.toString(), project: "Private finance project", repository: "Internal ledger",
    };
    const facet = state.facets.get<AzureBranchGatekeeper>("unverified", () => ({
      class: exports.AzureBranchGatekeeper({props}),
    }));
    return await facet.describe();
  });
  expect(description).toEqual({
    title: "Azure Repos branch", snippet: "", url: "",
    suggestedBindingName: "AZURE_REPOS_BRANCH", tsType: "AzureReposBranch",
  });
});

it("checks each observer's own PAT and advertises exactly the authorized commit", async () => {
  const owner = await connect("test-owner-pat");
  const noBranch = await connect("no-branch");
  const noContent = await connect("no-content");
  const outage = await connect("outage");
  const result = await runInDurableObject(owner.account, async (_, state) => {
    const observer = async (id: string, userObjectId: string) => ({
      id, verifier: await exports.AzureUser({props: {userObjectId}}).getVerifier(),
    });
    const observers = await Promise.all([
      observer("owner", owner.userObjectId), observer("no-branch", noBranch.userObjectId),
      observer("no-content", noContent.userObjectId),
    ]);
    const unavailable = await observer("outage", outage.userObjectId);
    const props: BranchProps = {...pin, userObjectId: owner.userObjectId, project: "Finance", repository: "Pilot"};
    const facet = state.facets.get<AzureBranchGatekeeper>("branch", () => ({
      class: exports.AzureBranchGatekeeper({props}),
    }));
    const recorder = new RecordingQueue();
    using queue = new RpcStub(recorder);
    using session = await facet.startSession(queue as unknown as ApprovalQueue);
    const checkout = await session.getCheckout();
    recorder.refuse = true;
    await expect(Promise.resolve(session.getCheckout())).rejects.toThrow();
    const subresources = recorder.observations[0].subresources!;
    expect(subresources[0]).toContain(encodeURIComponent(refName));
    expect(subresources[0]).toContain(commitId);
    await expect(Promise.resolve(facet.verifyObserverAccess(observers, ["unrelated"]))).rejects.toThrow();
    await expect(Promise.resolve(facet.verifyObserverAccess([unavailable], subresources))).rejects.toThrow();
    const access = await facet.verifyObserverAccess(observers, subresources);
    return {checkout, commits: recorder.commits, access, history: await facet.getHistoricalSubresources()};
  });
  expect(result).toEqual({
    checkout: {project: "Finance", repository: "Pilot", refName, commitId}, commits: [commitId],
    access: {allowedObserverIds: ["owner"]}, history: [],
  });
  const mine = await owner.account.confirmBranch(projectId, repositoryId, refName, commitId);
  expect((await owner.user.getGatekeeperClassFor(mine.resourceUrl!)).resource.id).toBe("branch");
  const inaccessible = await noContent.account.confirmBranch(projectId, repositoryId, refName, commitId);
  await expect(Promise.resolve(noContent.user.getGatekeeperClassFor(inaccessible.resourceUrl!))).rejects.toThrow();
});
