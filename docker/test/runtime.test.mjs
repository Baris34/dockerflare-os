import assert from "node:assert/strict";
import test from "node:test";
import modelTransport from "../model-transport.mjs";
import { deploymentOptions, renderConfig, runtimeServices } from "../workshop.mjs";

test("private inference only forwards the configured completions operation", async () => {
  const root = "http://inference:8000/team/v1";
  const calls = [];
  const env = {
    TARGETS: [root + "/chat/completions"],
    MODEL_NETWORK: { fetch(request) { calls.push(request); return new Response("stream"); } },
  };
  const request = new Request(root + "/chat/completions", {
    method: "POST", headers: { Authorization: "Bearer example", Cookie: "a=b", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(await (await modelTransport.fetch(request, env)).text(), "stream");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get("Authorization"), "Bearer example");
  assert.equal(calls[0].headers.get("Cookie"), null);
  assert.equal(calls[0].redirect, "manual");
  assert.equal((await modelTransport.fetch(new Request(root + "/models"), env)).status, 403);
  assert.equal(calls.length, 1);
});

test("a redirect is never relayed to the inference client", async () => {
  const url = "https://inference.example/v1/chat/completions";
  const env = { TARGETS: [url], MODEL_NETWORK: {
    fetch: () => Response.redirect("https://elsewhere.example"),
  } };
  const result = await modelTransport.fetch(new Request(url, { method: "POST" }), env);
  assert.equal(result.status, 502);
  assert.equal(result.headers.get("Location"), null);
});

test("private targets are explicit and the deployment keeps the normal CLI authorization", () => {
  const bundles = ["router", "workshop-backend", "gatekeeper-context", "gatekeeper-scheduler"].map(name => ({
    config: { name, compatibility_date: "2026-09-04" },
    mainModule: "index.js", modules: [{ name: "index.js", type: "esm" }],
  }));
  const options = deploymentOptions({ SELF_HOSTED_MODEL_BASE_URLS: '["https://internal.example/team/v1/"]' });
  const services = runtimeServices(bundles, options);
  assert.deepEqual(services.find(s => s.name === "internet").network.allow, ["public"]);
  const consumers = target => services.filter(s => s.worker?.globalOutbound === target ||
    s.worker?.bindings.some(b => (b.service?.name ?? b.service) === target)).map(s => s.name);
  assert.deepEqual(consumers("model-network"), ["model-transport"]);
  assert.deepEqual(consumers("model-transport"), ["workshop-backend"]);
  const config = renderConfig(bundles, options);
  assert.match(config, /MODEL_NETWORK/);
  assert.match(config, /team\/v1\/chat\/completions/);
  assert.doesNotMatch(config, /WORKSHOP_ENVIRONMENT/);
  assert.throws(() => deploymentOptions({ SELF_HOSTED_MODEL_BASE_URLS: '["https://example.invalid/v1?x=1"]' }));
});
