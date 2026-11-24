import assert from "node:assert/strict";
import test from "node:test";
import { verifyCheckout } from "./verify-checkout.mjs";

const collection = "https://azure.example.test/tfs/DefaultCollection";
const sample = {
  collection, pat: "sample-only", project: "Dev Team", repository: "Billing",
  branch: "release/4.8", path: "/Billing/Billing.csproj", version: "7.0",
};
const sha = "abc123abcd".repeat(4);
const projectId = "12345678-1234-1234-1234-123456789abc";
const repoId = "12345678-1234-1234-1234-123456789abd";

test("Azure contract selects a branch beyond the first page and reads the project at its commit", async () => {
  const paths = [];
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Basic " + btoa(":sample-only"));
    assert.equal(url.searchParams.get("api-version"), "7.0");
    paths.push(url.pathname);
    if (url.pathname.endsWith("/_apis/projects")) return Response.json({ value: [{ name: "Dev Team", id: projectId }] });
    if (url.pathname.endsWith("/repositories")) return Response.json({ value: [{ name: "Billing", id: repoId }] });
    if (url.pathname.endsWith("/refs")) {
      assert.equal(url.searchParams.get("filter"), "heads/release/4.8");
      if (!url.searchParams.has("continuationToken")) {
        return Response.json({ value: [{name: "refs/heads/release/4.8-preview", objectId: "0".repeat(40)}] },
          {headers: {"x-ms-continuationtoken": "opaque+/="}});
      }
      assert.equal(url.searchParams.get("continuationToken"), "opaque+/=");
      return Response.json({ value: [{ name: "refs/heads/release/4.8", objectId: sha }] });
    }
    assert.equal(url.searchParams.get("versionDescriptor.versionType"), "commit");
    assert.equal(url.searchParams.get("versionDescriptor.version"), sha);
    assert.equal(url.searchParams.get("path"), sample.path);
    return Response.json({path: sample.path, gitObjectType: "blob", commitId: sha, content: "<Project />"});
  };
  assert.deepEqual(await verifyCheckout(sample, fetcher), {commitId: sha, path: sample.path});
  assert.deepEqual(paths, [
    "/tfs/DefaultCollection/_apis/projects", `/tfs/DefaultCollection/${projectId}/_apis/git/repositories`,
    ...["refs", "refs", "items"].map(p => `/tfs/DefaultCollection/${projectId}/_apis/git/repositories/${repoId}/${p}`),
  ]);
});

test("rejects unsafe collection URLs before sending a credential", async () => {
  for (const url of ["http://dev.example/tfs", "https://user@dev.example/tfs", collection + "?version=7.0"]) {
    await assert.rejects(verifyCheckout({...sample, collection: url}, () => assert.fail("sent PAT")), /collection/i);
  }
});

test("access denial and malformed pages never print provider bodies or credentials", async () => {
  await assert.rejects(verifyCheckout(sample, () => new Response(sample.pat, {status: 403})),
    { message: "Azure DevOps projects returned HTTP 403." });
  await assert.rejects(verifyCheckout(sample, () => Response.json({value: []}, {headers: {"x-ms-continuationtoken": "same"}})),
    /repeated continuation token/);
});

const settings = {
  collection: process.env.AZURE_TEST_COLLECTION, pat: process.env.AZURE_TEST_PAT,
  project: process.env.AZURE_TEST_PROJECT, repository: process.env.AZURE_TEST_REPO,
  branch: process.env.AZURE_TEST_BRANCH, path: process.env.AZURE_TEST_CSPROJ,
  version: process.env.AZURE_TEST_API_VERSION ?? "7.0",
};
test("live Azure DevOps Server exposes the selected .csproj at the selected commit", {
  skip: !settings.collection && !settings.pat && "Set AZURE_TEST_COLLECTION and the pilot settings to run the live check.",
}, async () => {
  for (const [key, value] of Object.entries(settings)) assert.ok(value, "Missing Azure pilot setting: " + key);
  const checkout = await verifyCheckout(settings);
  assert.match(checkout.commitId, /^[0-9a-f]{40}$/);
  assert.equal(checkout.path, settings.path);
});
