import { describe, expect, it } from "vitest";
import { AzureAccessDenied, AzureClient, collectionUrl } from "../src/azure-client";

const collection = "https://ado.example.test/tfs/My%20Collection";
const project = "aaaaaaaa-0000-0000-0000-000000000001";
const repo = "bbbbbbbb-0000-0000-0000-000000000002";
const user = "cccccccc-0000-0000-0000-000000000003";
const instance = "dddddddd-0000-0000-0000-000000000004";
const pin = "1".repeat(40);
const tip = "2".repeat(40);
const tree = "3".repeat(40);
const branch = "refs/heads/team/İ";
const pat = "example-test-token";

function fixture(...responses: Response[]) {
  const requests: Request[] = [];
  const env = {
    AZURE_DEVOPS_COLLECTION_URL: collection + "/",
    AZURE_NETWORK: { async fetch(request: Request) {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected network request");
      return response;
    } },
  };
  return { client: new AzureClient(env, pat), env, requests };
}

function page(value: unknown[], token?: string) {
  return Response.json({ count: value.length, value }, {
    headers: token ? { "x-ms-continuationtoken": token } : {},
  });
}

const rootTree = { path: "/", gitObjectType: "tree", objectId: tree, commitId: pin };
const repository = () => Response.json({ id: repo, name: "Repo", project: { id: project } });

describe("Azure DevOps Server", () => {
  it("authenticates against the fixed collection and uses the provider's stable identity", async () => {
    const { client, requests } = fixture(Response.json({
      instanceId: instance, authenticatedUser: { id: user, providerDisplayName: "A User" },
    }));
    expect(await client.identity()).toEqual({ collectionId: instance, id: user, displayName: "A User" });
    const [request] = requests;
    expect(request.url).toBe(collection + "/_apis/connectionData?api-version=7.0-preview.1");
    expect(request.headers.get("authorization")).toBe("Basic " + btoa(":" + pat));
    expect(request.redirect).toBe("manual");
  });

  it.each(["http://test/tfs/c", "https://x:y@test/tfs/c", "https://test/tfs/c?q", "https://test/tfs/c#", "https://test/tfs\\c"])(
    "rejects unsafe or ambiguous collection configuration", value => {
      expect(() => collectionUrl({ AZURE_DEVOPS_COLLECTION_URL: value })).toThrow();
    },
  );

  it("preserves names, safely encodes continuations and never takes URLs from discovery results", async () => {
    const cursor = "a+/= &x=y";
    const { client, requests } = fixture(
      page([{ id: project, name: " Team/One" }], cursor),
      page([]),
      page([{ id: repo, name: " Repo", project: { id: project }, remoteUrl: "https://elsewhere.test" }], cursor),
      page([{ name: branch, objectId: pin }], "next"),
    );
    expect(await client.listProjects()).toEqual({ items: [{ id: project, name: " Team/One" }], nextCursor: cursor });
    await client.listProjects(cursor);
    expect(new URL(requests[1].url).searchParams.get("continuationToken")).toBe(cursor);
    expect((await client.listRepositories(project)).items).toEqual([{ id: repo, name: " Repo" }]);
    expect(await client.listBranches(project, repo, cursor)).toEqual({
      items: [{ refName: branch, commitId: pin }], nextCursor: "next",
    });
    expect(new URL(requests[3].url).searchParams.get("filter")).toBe("heads/");
    expect(requests.every(r => r.url.startsWith(collection + "/"))).toBe(true);
  });

  it("paginates native unpaged repo lists while preserving optional upstream continuations", async () => {
    const repos = Array.from({length: 102}, (_, i) => ({
      id: "bbbbbbbb-0000-0000-0000-" + String(i + 1).padStart(12, "0"), name: "repo " + i, project: {id: project},
    }));
    const {client, requests} = fixture(page(repos, "end+"), page(repos, "end+"), page([]));
    const first = await client.listRepositories(project);
    const second = await client.listRepositories(project, first.nextCursor);
    const last = await client.listRepositories(project, second.nextCursor);
    expect(first.items).toHaveLength(100);
    expect(second.items.map(i => i.name)).toEqual(["repo 100", "repo 101"]);
    expect(last.items).toEqual([]);
    expect(new URL(requests[2].url).searchParams.get("continuationToken")).toBe("end+");
  });

  it("uses neither a wrong project's ACL nor an incomplete access proof", async () => {
    const moved = fixture(Response.json({id: repo, name: "repo", project: {id: user}}));
    await expect(moved.client.verifyPinned(project, repo, branch, pin)).rejects.toBeInstanceOf(AzureAccessDenied);
    expect(moved.requests).toHaveLength(1);
    const wrongRoot = fixture(repository(), page([true]), page([{name: branch, objectId: pin}]),
      Response.json({...rootTree, commitId: tip}));
    await expect(wrongRoot.client.verifyPinned(project, repo, branch, pin)).rejects.toThrow("Invalid");
    const malformed = fixture(repository(), page(["true"]));
    await expect(malformed.client.verifyPinned(project, repo, branch, pin)).rejects.toThrow("Invalid");
  });

  it("does not select a prefix match, even on subsequent ref pages", async () => {
    const { client, requests } = fixture(page([{ name: branch + "-old", objectId: tip }], "token"),
      page([{ name: branch, objectId: pin }]));
    expect(await client.getBranch(project, repo, branch)).toEqual({ refName: branch, commitId: pin });
    expect(new URL(requests[1].url).searchParams.get("filter")).toBe("heads/team/İ");
    const missing = fixture(page([{ name: branch + "-old", objectId: tip }]));
    await expect(missing.client.getBranch(project, repo, branch)).rejects.toBeInstanceOf(AzureAccessDenied);
  });

  it("checks the precise case-sensitive branch ACL, ancestry and pinned content using the caller's PAT", async () => {
    const { client, requests } = fixture(repository(), page([true]), page([{ name: branch, objectId: tip }]),
      Response.json({ commonCommit: pin }), Response.json(rootTree));
    await client.verifyPinned(project, repo, branch, pin);
    const [, acl, , diff, content] = requests.map(req => new URL(req.url));
    expect(acl.pathname).toMatch(/\/_apis\/permissions\/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87\/2$/);
    expect(acl.searchParams.get("tokens")).toBe(`repoV2/${project}/${repo}/refs/heads/7400650061006d00/3001/`);
    expect(acl.searchParams.get("alwaysAllowAdministrators")).toBe("false");
    expect(diff.searchParams.get("baseVersion")).toBe(pin);
    expect(diff.searchParams.get("targetVersion")).toBe(tip);
    expect(content.searchParams.get("versionDescriptor.version")).toBe(pin);
    expect(content.searchParams.get("versionDescriptor.versionType")).toBe("commit");
    expect(requests.every(r => r.headers.get("authorization") === "Basic " + btoa(":" + pat))).toBe(true);
  });

  it("denies deleted/rewritten branches, negative ACLs and missing code read permission", async () => {
    for (const responses of [
      [page([false])],
      [page([true]), page([])],
      [page([true]), page([{ name: branch, objectId: tip }]), Response.json({ commonCommit: tree })],
      [page([true]), page([{ name: branch, objectId: pin }]), new Response(null, { status: 403 })],
    ]) {
      await expect(fixture(repository(), ...responses).client.verifyPinned(project, repo, branch, pin)).rejects.toBeInstanceOf(AzureAccessDenied);
    }
  });

  it("separates invalid auth and provider failure from denial without returning upstream content", async () => {
    for (const status of [401, 503, 302]) {
      const { client, requests } = fixture(new Response(pat, { status, headers: { location: "https://elsewhere.test/" + pat } }));
      const err = await client.listProjects().catch((error: Error) => error);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AzureAccessDenied);
      expect(String(err)).not.toContain(pat);
      expect(requests).toHaveLength(1);
    }
    await expect(fixture(new Response(pat)).client.identity()).rejects.toThrow(/invalid.*response/i);
  });

  it("only recognizes files and trees in the pinned snapshot, never gitlinks", async () => {
    const blob = { path: "/Solution.sln", commitId: pin, objectId: tip, gitObjectType: "blob" };
    const gitlink = { path: "/library", commitId: pin, objectId: "4".repeat(40), gitObjectType: "commit" };
    const { client, requests } = fixture(page([rootTree, blob, gitlink]), page([rootTree, blob, gitlink]));
    expect(await client.hasSnapshotObjects(project, repo, pin, [tree, tip])).toBe(true);
    expect(await client.hasSnapshotObjects(project, repo, pin, [gitlink.objectId])).toBe(false);
    expect(new URL(requests[0].url).searchParams.get("recursionLevel")).toBe("full");
  });

  it("rejects truncated object lists and objects from another revision", async () => {
    for (const response of [
      Response.json({count: 2, value: [rootTree]}),
      page([rootTree], "incomplete"),
      page([{...rootTree, commitId: tip}]),
      new Response("{}", {headers: {"content-length": String(64 * 1024 * 1024)}}),
    ]) {
      await expect(fixture(response).client.hasSnapshotObjects(project, repo, pin, [tree])).rejects.toThrow();
    }
  });

  it("uses only v0 smart HTTP upload-pack under the fixed repository and checks the service MIME type", async () => {
    const { client, requests } = fixture(
      new Response("discover", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } }),
      new Response("pack", { headers: { "content-type": "application/x-git-upload-pack-result" } }),
      new Response("sign in", { headers: { "content-type": "text/html" } }),
    );
    const base = collection + "/" + project + "/_git/" + repo;
    expect(await (await client.gitUploadPack(project, repo)).text()).toBe("discover");
    expect(await (await client.gitUploadPack(project, repo, Uint8Array.of(1, 2))).text()).toBe("pack");
    expect(requests[0].url).toBe(base + "/info/refs?service=git-upload-pack");
    expect(requests[1].url).toBe(base + "/git-upload-pack");
    expect(requests[1].method).toBe("POST");
    expect(requests[1].headers.get("content-type")).toBe("application/x-git-upload-pack-request");
    expect(requests.every(r => !r.headers.has("Git-Protocol"))).toBe(true);
    await expect(client.gitUploadPack(project, repo)).rejects.toThrow();
    await expect(client.gitUploadPack("../other", repo)).rejects.toThrow();
    expect(requests).toHaveLength(3);
  });
});
