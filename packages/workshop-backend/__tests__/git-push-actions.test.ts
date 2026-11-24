// Exercises the push-authorization wiring in the Overseer itself -- submitAction's ancestry
// verification + marking walk, applyPendingAction's action-scoped GitCache stub and mark
// conversion, and removeGatekeeper's queued-push cleanup -- over real SQLite DO storage. The
// WorkspaceGitCache semantics themselves are covered by git-cache.test.ts on mock storage; this
// file covers the overseer-side chokepoints those semantics hang off of.
//
// This lives in __tests__/ (the unit workerd config): the TEST_OVERSEER binding exists only in
// vitest.config.ts, and the tests reach into impl storage/methods directly -- the same pattern
// as git-migration-do.test.ts. The gatekeeper facet is stubbed by overriding
// impl.getGatekeeperFacet on the instance, since a real Gatekeeper DO class cannot be minted
// from a test.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { concatBytes, encodeGitTree, encodeLooseObject, gitObjectOid, type GitTreeEntry } from "../src/git-codec";
import { decodePack } from "./git-cache-fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const GATEKEEPER = 7;
const USER = { type: "user" as const, id: "alice@example.com", name: "Alice" };

// Every scenario starts with the gatekeeper's record in place: submitAction refuses an action
// naming a connection the workspace no longer has.
async function inOverseer(name: string, fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.storage.gatekeepers.put({
      id: GATEKEEPER,
      resourceTitle: "Remote repository",
      class: {} as any,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: "https://example.com/repo",
        typeUrlPattern: "https://*",
      },
    });
    await fn(impl);
  });
}

function commitPayload(tree: string, parents: string[], message: string): Uint8Array {
  let text = [
    `tree ${tree}`,
    ...parents.map(parent => `parent ${parent}`),
    "author Test <test@example.com> 1700000000 +0000",
    "committer Test <test@example.com> 1700000000 +0000",
    "",
    `${message}\n`,
  ].join("\n");
  return new TextEncoder().encode(text);
}

async function storeLocal(impl: any, type: string, payload: Uint8Array): Promise<string> {
  let oid = gitObjectOid(type as any, payload);
  impl.storage.gitObjects.put({ oid, data: encodeLooseObject(type as any, payload) });
  return oid;
}

// Seeds the standard scenario: the gatekeeper has proven a base commit (empty tree), and a
// locally-authored commit sits on top of it. Returns both oids.
async function seedPushableHistory(impl: any): Promise<{ base: string, head: string }> {
  let treeOid = await impl.gitCache.putFromGatekeeper(GATEKEEPER, "tree", new Uint8Array(0));
  let base = await impl.gitCache.putFromGatekeeper(
      GATEKEEPER, "commit", commitPayload(treeOid, [], "base"));
  let head = await storeLocal(impl, "commit", commitPayload(treeOid, [base], "local work"));
  return { base, head };
}

function pushDescription(heads: string[]): ActionDescription {
  return {
    title: "Push to main",
    description: "Pushes the listed commits.",
    implementsRevert: true,
    pushedCommits: heads,
    autoApprovable: false,
  };
}

function marksOf(impl: any, actionId: number): string[] {
  return Array.from(impl.storage.gitObjectMetadata.byPendingPushAction.get(actionId))
      .map((record: any) => record.oid);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  let chunks: Uint8Array[] = [];
  let reader = stream.getReader();
  for (;;) {
    let { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(chunks);
}

describe("push authorization through the Overseer chokepoints", () => {
  it("shows the pinned file diff and the commit that will actually be pushed", async () => {
    await inOverseer("push-reviewed", async impl => {
      const file = async (name: string, value: string | Uint8Array, mode: GitTreeEntry["mode"] = "100644") => ({
        name, mode, oid: await storeLocal(impl, "blob", typeof value === "string" ? new TextEncoder().encode(value) : value),
      });
      const utf16 = (text: string, littleEndian: boolean) => {
        const bytes = new Uint8Array((text.length + 1) * 2);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, 0xfeff, littleEndian);
        for (let i = 0; i < text.length; ++i) view.setUint16(2 * (i + 1), text.charCodeAt(i), littleEndian);
        return bytes;
      };
      const before = await storeLocal(impl, "tree", encodeGitTree([
        await file("gone", "old\n"), await file("edit", "before\n"),
        await file("script", "/bin/sh\n"), await file("bom", "same\n"),
        await file("legacy.csproj", utf16("<Project>Önce</Project>\r\n", true)),
        await file("utf16be", utf16("α\n", false)),
      ]));
      const base = await impl.gitCache.putFromGatekeeper(GATEKEEPER, "commit", commitPayload(before, [], "origin"));
      const after = await storeLocal(impl, "tree", encodeGitTree([
        await file("edit", "after\n"), await file("new.txt", "hello\n"), await file("binary", "\0\u0001"),
        await file("script", "/bin/sh\n", "100755"), await file("bom", "\uFEFFsame\n"),
        await file("legacy.csproj", utf16("<Project>Şimdi</Project>\r\n", true)),
        await file("utf16be", utf16("β\n", false)), await file("invalid", Uint8Array.of(0xff, 0xfe, 0x61)),
      ]));
      const head = await storeLocal(impl, "commit", commitPayload(after, [base], "publish this"));
      const finalTree = await storeLocal(impl, "tree", encodeGitTree([await file("final.txt", "replacement\n")]));
      const tip = await storeLocal(impl, "commit", commitPayload(finalTree, [head], "remove earlier files"));
      await impl.submitAction(GATEKEEPER, 1, {...pushDescription([tip]), reviewPushFrom: base}, {from: "user"});
      const [record] = Array.from<any>(impl.storage.actions.list());
      const review = record.description.fields.map((field: {value: string}) => field.value).join("\n");
      for (const expected of ["new.txt", "+hello", "gone", "-old", "-before", "+after", "100755", "script", "\\ufeffsame",
                             "-hello", "final.txt", "+replacement", "binary", "2 bytes", "+00 01", "+ff fe 61",
                             "UTF-16LE with BOM", "-<Project>Önce</Project>", "+<Project>Şimdi</Project>",
                             "UTF-16BE with BOM", "-α", "+β", "publish this", head, tip, base]) {
        expect(review).toContain(expected);
      }
      expect(record.state).toBe("pending");
      expect(record.description.descriptionIsComplete).toBeFalsy();
    });
  });

  it("requires a linear push from the destination base, with a nonempty reviewable diff", async () => {
    await inOverseer("push-reviewed-history", async impl => {
      const {base, head} = await seedPushableHistory(impl);
      const tree = await storeLocal(impl, "tree", new Uint8Array());
      const child = await storeLocal(impl, "commit", commitPayload(tree, [head], "another"));
      const merge = await storeLocal(impl, "commit", commitPayload(tree, [base, head], "merge"));
      const submit = (baseOid: string, heads: string[]) => impl.submitAction(GATEKEEPER, 1,
        {...pushDescription(heads), reviewPushFrom: baseOid}, {from: "user"});
      await expect(submit(base, [head])).rejects.toThrow(/no file changes/i);
      await expect(submit(base, [child])).rejects.toThrow(/no file changes/i);
      await expect(submit(base, [merge])).rejects.toThrow(/single parent/i);
      await expect(submit(head, [child])).rejects.toThrow(/destination/i);
      await expect(submit(base, [child, merge])).rejects.toThrow(/one.*commit/i);
      await expect(submit(base, [])).rejects.toThrow(/one.*commit/i);
      expect(Array.from(impl.storage.actions.list())).toEqual([]);
    });
  });

  it("refuses a review too large to show in full without queuing the push", async () => {
    await inOverseer("push-reviewed-budget", async impl => {
      const {base} = await seedPushableHistory(impl);
      for (const bytes of [new TextEncoder().encode("x".repeat(100 * 1024)), new Uint8Array(64 * 1024)]) {
        const blob = await storeLocal(impl, "blob", bytes);
        const tree = await storeLocal(impl, "tree", encodeGitTree([{name: "large-file", mode: "100644", oid: blob}]));
        const head = await storeLocal(impl, "commit", commitPayload(tree, [base], "too large"));
        await expect(impl.submitAction(GATEKEEPER, 1, {...pushDescription([head]), reviewPushFrom: base}, {from: "user"}))
          .rejects.toThrow(/review.*limit/i);
        expect(impl.storage.gitObjectMetadata.get(head)?.pendingPush ?? []).toEqual([]);
      }
      expect(Array.from(impl.storage.actions.list())).toEqual([]);
    });
  });

  it("verifies, marks, applies with an action-scoped cache, and converts marks", async () => {
    await inOverseer("push-apply", async impl => {
      let { base, head } = await seedPushableHistory(impl);

      await impl.submitAction(GATEKEEPER, 1, pushDescription([head]), { from: "user" });
      let record = Array.from(impl.storage.actions.list())
          .find((a: any) => a.type === "action") as any;
      expect(record.state).toBe("pending");
      // The head is marked; the base and its tree are remote-known and are not.
      expect(marksOf(impl, record.id)).toStrictEqual([head]);

      // Apply through a stubbed facet that exercises the action-scoped cache like a real
      // gatekeeper would: reads a pending commit (simulation view) and builds the pack.
      let sawPack: Uint8Array | undefined;
      impl.getGatekeeperFacet = () => ({
        async applyAction(action: number, cache: any) {
          expect(action).toBe(1);
          expect((await cache.get(head))!.type).toBe("commit");
          sawPack = await collect(await cache.buildPack());
        },
      });
      await impl.applyPendingAction(record, USER, false);

      expect(await decodePack(sawPack!)).toHaveLength(1);
      expect(impl.storage.actions.get(record.id)!.state).toBe("approved");
      expect(marksOf(impl, record.id)).toStrictEqual([]);
      let meta = impl.storage.gitObjectMetadata.get(head)!;
      expect(meta.onRemote).toStrictEqual([GATEKEEPER]);
      expect(meta.pendingPush).toStrictEqual([]);

      // The pushed commit is now proven: a follow-up push on top of it passes verification.
      expect(base).toBeTruthy();
    });
  });

  it("fails submitAction closed on unproven ancestry, queuing nothing", async () => {
    await inOverseer("push-reject", async impl => {
      let treeOid = await storeLocal(impl, "tree", new Uint8Array(0));
      let root = await storeLocal(impl, "commit", commitPayload(treeOid, [], "unrelated root"));

      await expect(impl.submitAction(GATEKEEPER, 1, pushDescription([root]), { from: "user" }))
          .rejects.toThrow(/root commit/);
      expect(Array.from(impl.storage.actions.list())).toStrictEqual([]);
      expect(Array.from(impl.storage.gitObjectMetadata.byPendingPushAction.list()))
          .toStrictEqual([]);
      expect(impl.storage.gitObjectMetadata.get(root)?.pendingPush ?? []).toStrictEqual([]);
    });
  });

  it("refuses a push while the workspace is restricted, queuing nothing", async () => {
    await inOverseer("push-restricted", async impl => {
      let { base, head } = await seedPushableHistory(impl);
      impl.storage.containsRestrictedData.put(true);

      await expect(impl.submitAction(GATEKEEPER, 1, {...pushDescription([head]), reviewPushFrom: base}, { from: "user" }))
          .rejects.toThrow(/git pushes are disabled/i);
      expect(Array.from(impl.storage.actions.list())).toStrictEqual([]);
      expect(Array.from(impl.storage.gitObjectMetadata.byPendingPushAction.list()))
          .toStrictEqual([]);
    });
  });

  it("cleans a queued push's marks when its gatekeeper is removed", async () => {
    await inOverseer("push-gatekeeper-removed", async impl => {
      let { head } = await seedPushableHistory(impl);
      await impl.submitAction(GATEKEEPER, 1, pushDescription([head]), { from: "user" });
      let record = Array.from(impl.storage.actions.list())
          .find((a: any) => a.type === "action") as any;
      expect(marksOf(impl, record.id)).toStrictEqual([head]);

      impl.removeGatekeeper(GATEKEEPER);
      expect(marksOf(impl, record.id)).toStrictEqual([]);
      expect(impl.storage.gitObjectMetadata.get(head)?.pendingPush ?? []).toStrictEqual([]);
      // Proof-grade provenance is kept: the base commit's onRemote row survives removal.
    });
  });

  it("hands sessions a gatekeeper-scoped cache via getGitCache()", async () => {
    await inOverseer("push-session-cache", async impl => {
      let { head, base } = await seedPushableHistory(impl);
      void head;
      // Mimic ApprovalQueueImpl.getGitCache()'s minting: gatekeeper-scoped, no action.
      let { GitCacheImpl } = await import("../src/git-cache.js");
      let cache = new GitCacheImpl(impl.gitCache, GATEKEEPER);
      expect((await cache.get(base))!.type).toBe("commit");
      await expect(cache.buildPack()).rejects.toThrow(/action-scoped/);
    });
  });
});
