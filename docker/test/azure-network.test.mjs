import assert from "node:assert/strict";
import test from "node:test";
import worker from "../azure-network.mjs";
import { deploymentOptions, runtimeServices } from "../workshop.mjs";

const collection = "https://devops.example.test/tfs/Engineering";
const id = "00000001-0002-0003-0004-000000000005";
const root = collection + "/" + id + "/_git/" + id;

test("Azure access stays inside the operator collection and grants only reads and upload-pack", async () => {
  const calls = [];
  const env = {COLLECTION: collection, AZURE_UPSTREAM: {fetch: request => {
    calls.push(request);
    return new Response("ok");
  }}};
  for (const [url, method, status] of [
    [collection + "/_apis/projects", "GET", 200],
    [collection + "/" + id + "/_apis/git/repositories/" + id + "/refs?filter=heads%2F", "GET", 200],
    [root + "/info/refs?service=git-upload-pack", "GET", 200],
    [root + "/git-upload-pack", "POST", 200],
    [root + "/git-receive-pack", "POST", 403],
    [root + "/info/refs?service=git-receive-pack", "GET", 403],
    [collection + "/_apis/projects", "POST", 403],
    [collection + "Outer/_apis/projects", "GET", 403],
    ["https://elsewhere.example/_apis/projects", "GET", 403],
    [collection + "/" + id + "/_apis/git/repositories/" + id + "/%252e%252e/refs", "GET", 403],
  ]) {
    const request = new Request(url, {method, headers: {authorization: "Basic fixture", cookie: "secret"}});
    assert.equal((await worker.fetch(request, env)).status, status);
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every(request => request.redirect === "manual" && !request.headers.has("cookie")
    && request.headers.get("authorization") === "Basic fixture"));
});

test("redirects never carry the PAT to a second destination", async () => {
  const env = {COLLECTION: collection, AZURE_UPSTREAM: {fetch: () => Response.redirect("https://other.example/")}};
  assert.equal((await worker.fetch(new Request(collection + "/_apis/projects"), env)).status, 502);
});

test("Docker only gives the Azure gatekeeper the collection-bound transport", () => {
  const bundles = ["router", "workshop-backend", "gatekeeper-azure-repos"].map(name => ({
    config: {name}, ...(name === "gatekeeper-azure-repos" && {shortName: "azurerepos"}),
    mainModule: "index.js", modules: [{name: "index.js", type: "esm"}],
  }));
  const options = deploymentOptions({GATEKEEPERS: "azurerepos", AZURE_DEVOPS_COLLECTION_URL: collection});
  const services = runtimeServices(bundles, options);
  const users = name => services.filter(s => s.worker?.bindings.some(b => b.service === name)).map(s => s.name);
  assert.deepEqual(users("azure-transport"), ["gatekeeper-azure-repos"]);
  assert.deepEqual(users("azure-network"), ["azure-transport"]);
  assert.deepEqual(services.find(s => s.name === "internet").network.allow, ["public"]);
  assert.throws(() => runtimeServices(bundles, deploymentOptions({GATEKEEPERS: "azurerepos"})), /COLLECTION_URL/);
});
