import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { BranchConfiguratorRpc } from "../../src/configurator/branch-configurator-types";
import { collectionId, commitId, projectId, refName, repositoryId } from "./fake-azure";

const collection = "https://ado.test/tfs/DefaultCollection";

async function account() {
  const id = env.USER_ACCOUNT.newUniqueId();
  const object = env.USER_ACCOUNT.get(id);
  const user = exports.AzureUser({props: {userObjectId: id.toString()}});
  // The fake Azure service varies its ref/content responses by token to model external changes.
  const as = async (pat: string, tenant = collectionId) => runInDurableObject(object, (_, state) => {
    state.storage.kv.put("credentials", {id: "55555555-0000-0000-0000-111111111111", collectionId: tenant,
      collection, displayName: "Test", pat, generation: crypto.randomUUID()});
  });
  await as("test-picker");
  const frame = await user.startResourceConfigurator("branch");
  const ui = frame.ui as unknown as BranchConfiguratorRpc;
  return {object, user, as, ui, frame};
}

it("returns an account-bound opaque selection that can be attached after a fast-forward or same-account reconnect", async () => {
  const owner = await account();
  using _frame = owner.frame;
  const pick = (sha: string) => owner.ui.confirmBranch(projectId, repositoryId, refName, sha);
  expect(await pick("b".repeat(40))).toEqual({commitId});
  const url = (await pick(commitId)).resourceUrl!;
  expect(url).toMatch(/^https:\/\/azure-repos\.invalid\/selection\/v1-[A-Za-z0-9_-]+$/);
  for (const privateValue of [collection, projectId, repositoryId, refName, commitId]) expect(url).not.toContain(privateValue);
  const keyCount = () => runInDurableObject(owner.object, async (_, state) => (await state.storage.list()).size);
  const stored = await keyCount();
  expect((await pick(commitId)).resourceUrl).not.toBe(url);
  expect(await keyCount()).toBe(stored);
  expect((await owner.user.getGatekeeperClassFor(url)).resource.id).toBe("branch");
  await owner.as("advanced");
  expect((await owner.user.getGatekeeperClassFor(url)).resource.id).toBe("branch");

  for (const state of ["rewritten", "deleted", "no-content"]) {
    await owner.as(state);
    await expect(Promise.resolve(owner.user.getGatekeeperClassFor(url))).rejects.toThrow();
  }
  await owner.user.revoke();
  await expect(Promise.resolve(pick(commitId))).rejects.toThrow();
});

it("rejects raw Azure URLs, forged selections, other accounts and other collections", async () => {
  const owner = await account();
  const other = await account();
  using _firstFrame = owner.frame;
  using _secondFrame = other.frame;
  const pick = (ui: BranchConfiguratorRpc) => ui.confirmBranch(projectId, repositoryId, refName, commitId);
  const url = (await pick(owner.ui)).resourceUrl!;
  await pick(other.ui); // Another connected account with the same Azure identity has its own key.
  await expect(Promise.resolve(other.user.getGatekeeperClassFor(url))).rejects.toThrow();
  const raw = `${collection}/${projectId}/_git/${repositoryId}?version=GBfeature%2Fpilot&commit=${commitId}`;
  const tampered = url.slice(0, -10) + (url.at(-10) === "A" ? "B" : "A") + url.slice(-9);
  for (const invalid of [raw, tampered, url.replace("azure-repos.invalid", "other.invalid"), url + "?query=1"]) {
    await expect(Promise.resolve(owner.user.getGatekeeperClassFor(invalid))).rejects.toThrow();
  }
  await owner.as("test-picker", "33333333-0000-0000-0000-222222222222");
  await expect(Promise.resolve(owner.object.resolveSelection(url))).rejects.toThrow();
});
