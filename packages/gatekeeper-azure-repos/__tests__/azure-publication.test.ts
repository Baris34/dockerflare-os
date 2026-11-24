import { expect, it } from "vitest";
import { AzureClient } from "../src/azure-client";
import { publishAzurePullRequest } from "../src/azure-publication";

const collection = "https://azure.example.test/tfs/Collection";
const projectId = "aaaaaaaa-0000-0000-0000-000000000001";
const repositoryId = "bbbbbbbb-0000-0000-0000-000000000002";
const refName = "refs/heads/release";
const sourceRefName = "refs/heads/agents/10000000-0000-4000-8000-000000000001";
const head = "c".repeat(40);
const commitId = "b".repeat(40);
const input = {projectId, repositoryId, refName, sourceRefName, head, commitId, title: "Review", description: "Add a file"};
const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
const result = {pullRequestId: 17, url: collection + "/Team%20A/_git/Pilot/pullrequest/17"};
const cache = {async buildPack() { return new Response("PACK test objects").body!; }};

function server() {
  const state = {
    sourceHead: "", pr: false, closed: false, changeSource: false, failCreate: false, rejectPush: false,
    foreignFork: false, movedDuringCreate: false, lostPushReply: false, lostPrReply: false,
    includeHistoricalHead: false, redirectWriter: false, unsupportedWriteRoute: false, wrongIdentityOnWrite: false, checkedGitIdentity: 0,
    targetHead: commitId, mutableNameRequests: [] as string[],
    caps: "report-status", gitBodies: [] as string[], prBodies: [] as unknown[], readStatuses: [] as string[],
  };
  const repository = {id: repositoryId, name: "Pilot", project: {id: projectId, name: "Team A"}};
  const pr = () => ({pullRequestId: 17, status: state.closed ? "completed" : "active", repository,
    sourceRefName: state.changeSource ? refName : sourceRefName, targetRefName: refName,
    forkSource: state.foreignFork ? {repository: {id: projectId}, name: sourceRefName} : undefined,
    lastMergeSourceCommit: state.movedDuringCreate && !state.includeHistoricalHead ? undefined : {commitId: head},
    _links: {web: {href: "https://other.example/"}}, url: "https://other.example/"});
  const jsonPath = "/" + projectId + "/_apis/git/repositories/" + repositoryId;
  const gitPath = "/" + projectId + "/_git/" + repositoryId;
  const client = new AzureClient({AZURE_DEVOPS_COLLECTION_URL: collection, AZURE_NETWORK: {
    async fetch(request: Request) {
      const url = new URL(request.url);
      const path = url.pathname.slice(new URL(collection).pathname.length);
      if (path === jsonPath && request.method === "GET") return Response.json(repository);
      if (path === jsonPath + "/refs" && request.method === "GET") {
        return Response.json({value: [{name: refName, objectId: state.targetHead}]});
      }
      if (path.startsWith("/Team%20A/_git/")) state.mutableNameRequests.push(path);
      if (path === gitPath + "/vsts/info" && request.method === "GET") {
        state.checkedGitIdentity++;
        if (state.unsupportedWriteRoute) return new Response(null, {status: 404});
        if (state.redirectWriter) return Response.redirect(collection + "/Team%20A/_git/Pilot/vsts/info", 302);
        return Response.json({repository: {...repository,
          id: state.wrongIdentityOnWrite && state.checkedGitIdentity > 1 ? projectId : repository.id}});
      }
      if (path === gitPath + "/info/refs" && url.search === "?service=git-receive-pack") {
        const refs = pkt("# service=git-receive-pack\n") + "0000" +
          pkt(commitId + " " + refName + "\0" + state.caps + "\n") +
          (state.sourceHead ? pkt(state.sourceHead + " " + sourceRefName + "\n") : "") + "0000";
        return new Response(refs, {headers: {"Content-Type": "application/x-git-receive-pack-advertisement"}});
      }
      if (path === gitPath + "/git-receive-pack" && request.method === "POST") {
        state.gitBodies.push(await request.text());
        const report = state.rejectPush ? "ng " + sourceRefName + " secret reflect-me-token" : "ok " + sourceRefName;
        if (!state.rejectPush) state.sourceHead = head;
        if (state.lostPushReply) return new Response(null, {status: 502});
        return new Response(pkt("unpack ok\n") + pkt(report + "\n") + "0000", {
          headers: {"Content-Type": "application/x-git-receive-pack-result"},
        });
      }
      if (path === jsonPath + "/pullrequests") {
        if (request.method === "GET") {
          expect(url.searchParams.get("searchCriteria.sourceRefName")).toBe(sourceRefName);
          expect(url.searchParams.get("searchCriteria.targetRefName")).toBe(refName);
          state.readStatuses.push(url.searchParams.get("searchCriteria.status")!);
          return Response.json({value: state.pr ? [pr()] : []});
        }
        if (request.method === "POST" && request.headers.get("content-type") === "application/json") {
          state.prBodies.push(await request.json());
          if (state.failCreate) return new Response(null, {status: 503});
          state.pr = true;
          if (state.movedDuringCreate) state.sourceHead = commitId;
          if (state.lostPrReply) return new Response(null, {status: 502});
          return Response.json(pr(), {status: 201});
        }
      }
      return new Response(null, {status: 404});
    },
  }}, "fixture-token");
  return {client, state};
}

it("publishes only the approved head on a new agents branch and resumes after a partial write", async () => {
  const {client, state} = server();
  state.failCreate = true;
  await expect(publishAzurePullRequest(client, cache, input)).rejects.toThrow(/503/);
  state.failCreate = false;
  state.targetHead = "e".repeat(40); // The original approved push already landed.
  expect(await publishAzurePullRequest(client, cache, input)).toEqual(result);
  expect(await publishAzurePullRequest(client, cache, input)).toEqual(result);
  expect(state.gitBodies).toEqual([
    pkt("0".repeat(40) + " " + head + " " + sourceRefName + "\0report-status\n") + "0000PACK test objects",
  ]);
  const expected = {sourceRefName, targetRefName: refName, title: input.title, description: input.description};
  expect(state.prBodies).toEqual([expected, expected]);
  expect(state.mutableNameRequests).toEqual([]);
  expect(state.readStatuses.every(status => status === "all")).toBe(true);
});

it.each(["", commitId])("recognizes a closed PR even if its source was removed or repurposed (%s)", async source => {
  const {client, state} = server();
  state.pr = state.closed = true;
  state.sourceHead = source;
  expect(await publishAzurePullRequest(client, cache, input)).toEqual(result);
  expect(state.gitBodies).toEqual([]);
  expect(state.prBodies).toEqual([]);
});

it("recovers lost success responses without repeating either write", async () => {
  const {client, state} = server();
  state.lostPushReply = state.lostPrReply = true;
  expect(await publishAzurePullRequest(client, cache, input)).toEqual(result);
  expect(state.gitBodies).toHaveLength(1);
  expect(state.prBodies).toHaveLength(1);
});

it.each([true, false])("rechecks the source branch when Azure's merge calculation is stale (has prior SHA: %s)", async retained => {
  const {client, state} = server();
  state.movedDuringCreate = true;
  state.includeHistoricalHead = retained;
  await expect(publishAzurePullRequest(client, cache, input)).rejects.toThrow(/approved commit/);
  await expect(publishAzurePullRequest(client, cache, input)).rejects.toThrow(/approved commit/);
  expect(state.gitBodies).toHaveLength(1);
  expect(state.prBodies).toHaveLength(1);
});

it("refuses newly moved publication targets before sending any workspace data", async () => {
  const {client, state} = server();
  state.targetHead = "f".repeat(40);
  const error = await publishAzurePullRequest(client, cache, input).catch((cause: unknown) => cause);
  expect(String(error)).toMatch(/target branch moved.*select.*review/i);
  expect(String(error)).not.toContain(state.targetHead);
  expect(state.gitBodies).toEqual([]);
  expect(state.prBodies).toEqual([]);
});

it("fails closed when the GUID route redirects or resolves to another repository before the push", async () => {
  const {client, state} = server();
  state.redirectWriter = true;
  await expect(publishAzurePullRequest(client, cache, input)).rejects.toThrow();
  state.redirectWriter = false;
  state.checkedGitIdentity = 0;
  state.wrongIdentityOnWrite = true;
  await expect(publishAzurePullRequest(client, cache, input)).rejects.toThrow();
  expect(state.gitBodies).toEqual([]);
  expect(state.prBodies).toEqual([]);
  expect(state.mutableNameRequests).toEqual([]);
});

it("explains an unsupported ID-addressed Git route without falling back to repository names", async () => {
  const {client, state} = server();
  state.unsupportedWriteRoute = true;
  await expect(publishAzurePullRequest(client, cache, input)).rejects.toThrow(/GUID.*vsts\/info.*404/i);
  expect(state.gitBodies).toEqual([]);
  expect(state.prBodies).toEqual([]);
  expect(state.mutableNameRequests).toEqual([]);
});

it("refuses a different source tip or PR identity without writing", async () => {
  const {client, state} = server();
  state.sourceHead = commitId;
  await expect(publishAzurePullRequest(client, cache, input)).rejects.toThrow();
  state.sourceHead = head;
  state.pr = state.changeSource = true;
  await expect(publishAzurePullRequest(client, cache, input)).rejects.toThrow();
  state.changeSource = false;
  state.foreignFork = true;
  await expect(publishAzurePullRequest(client, cache, input)).rejects.toThrow();
  expect(state.gitBodies).toEqual([]);
  expect(state.prBodies).toEqual([]);
});

it("rejects unsafe destinations, missing report-status and provider-controlled push errors", async () => {
  const {client, state} = server();
  await expect(publishAzurePullRequest(client, cache, {...input, sourceRefName: refName})).rejects.toThrow();
  await expect(publishAzurePullRequest(client, cache, {...input, sourceRefName: "refs/heads/agents/manual"})).rejects.toThrow();
  await expect(publishAzurePullRequest(client, cache, {...input, refName: sourceRefName})).rejects.toThrow();
  state.caps = "delete-refs";
  await expect(publishAzurePullRequest(client, cache, input)).rejects.toThrow(/report-status/);
  expect(state.gitBodies).toEqual([]);
  state.caps = "report-status agent=git/server";
  state.rejectPush = true;
  const error = await publishAzurePullRequest(client, cache, input).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain("reflect-me-token");
  expect(state.gitBodies[0]).toContain("report-status agent=");
  expect(state.prBodies).toEqual([]);
});
