export const collectionId = "33333333-0000-0000-0000-111111111111";
export const projectId = "11111111-0000-0000-0000-111111111111";
export const repositoryId = "22222222-0000-0000-0000-111111111111";
export const refName = "refs/heads/feature/pilot";
export const commitId = "a".repeat(40);
const sameUser = "55555555-0000-0000-0000-111111111111";
const otherUser = "55555555-0000-0000-0000-222222222222";
const root = "/tfs/DefaultCollection/";
const repository = root + projectId + "/_apis/git/repositories/" + repositoryId;

export async function fakeAzure(req: Request): Promise<Response> {
  const pat = atob((req.headers.get("authorization") ?? "").slice(6)).slice(1);
  const path = new URL(req.url).pathname;
  if (pat === "rejected") return new Response("Rejected " + pat, {status: 401});
  if (path === root + "_apis/connectionData") {
    return Response.json({instanceId: collectionId, authenticatedUser: {
      id: pat === "other" ? otherUser : sameUser, providerDisplayName: "Test user",
    }});
  }
  if (path === root + "_apis/projects/" + projectId) return Response.json({id: projectId, name: "Finance"});
  if (path === repository) return Response.json({id: repositoryId, name: "Pilot", project: {id: projectId}});
  if (path.includes("/_apis/permissions/")) return Response.json({value: [pat !== "no-branch"]});
  if (path === repository + "/refs") {
    const tip = pat === "advanced" || pat === "rewritten" ? "b".repeat(40) : commitId;
    return Response.json({value: pat === "deleted" ? [] : [{name: refName, objectId: tip}]});
  }
  if (path === repository + "/diffs/commits") return Response.json({commonCommit: pat === "advanced" ? commitId : null});
  if (path === repository + "/items") {
    if (pat === "no-content") return new Response(null, {status: 403});
    if (pat === "outage") return new Response(null, {status: 503});
    return Response.json({path: "/", gitObjectType: "tree", objectId: "c".repeat(40), commitId});
  }
  return new Response(null, {status: 404});
}
