import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { devModelWorkerConfig } from "./dev-model/config.ts";
import worker from "./dev-model/worker.mjs";

test("local model configuration is opt-in and targets only exact completions URLs", () => {
  assert.equal(devModelWorkerConfig(undefined), undefined);
  assert.equal(devModelWorkerConfig("[]"), undefined);
  const config = devModelWorkerConfig('["http://model.test/v1/", "http://model.test/v1"]');
  assert.deepEqual(config?.vars.TARGETS, ["http://model.test/v1/chat/completions"]);
  assert.deepEqual(config?.roots, ["http://model.test/v1"]);
  assert.throws(() => devModelWorkerConfig('"http://model.test/v1"'));
  assert.throws(() => devModelWorkerConfig('["http://model.test/v1?token=secret"]'));
});

test("the dev binding reaches a local endpoint, sanitizes headers and refuses other routes", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, "Bearer test-only");
    res.end("local stream");
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const root = `http://127.0.0.1:${address.port}/dev/v1`;
    const { vars } = devModelWorkerConfig(JSON.stringify([root]))!;
    const init = { method: "POST", body: "{}", headers: { authorization: "Bearer test-only", cookie: "private=1" } };
    const sent = await worker.fetch(new Request(root + "/chat/completions", init), vars);
    assert.equal(await sent.text(), "local stream");
    const blocked = await worker.fetch(new Request(root + "/other", init), vars);
    assert.equal(blocked.status, 403);
    assert.deepEqual(seen, ["/dev/v1/chat/completions"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
