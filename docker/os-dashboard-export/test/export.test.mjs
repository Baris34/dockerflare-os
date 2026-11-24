import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";

test("projects legacy and current Workshop records, updates old approvals, and joins only exact gateway IDs", async (t) => {
  const { openProjection } = await import("../export.mjs");
  const dir = mkdtempSync(join(tmpdir(), "os-dashboard-export-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const objectsDir = join(dir, "objects"),
    ns = join(objectsDir, "workshop-backend-OverseerDurableObject");
  mkdirSync(ns, { recursive: true });
  const workspace = "a".repeat(64),
    source = new DatabaseSync(join(ns, workspace + ".sqlite"));
  const secret = "fixture-private-text-outside-export";
  source.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB);",
  );
  const put = (key, obj) =>
    source
      .prepare("INSERT OR REPLACE INTO _cf_KV VALUES(?,?)")
      .run(key, serialize(obj));
  const user = { type: "user", id: "member@example.test", name: secret };
  const agent = { type: "agent", id: "requested-model", name: secret };
  const message = (sequence, body, author = agent) =>
    put("chats:a0.a" + sequence, {
      chatId: 0,
      sequence,
      timestamp: new Date(1000 + sequence),
      author,
      ...body,
    });
  put("chatMeta:a0", {
    id: 0,
    started: new Date(1000),
    lastActive: new Date(1010),
    title: secret,
  });
  message(0, { type: "message", message: secret }, user);
  message(1, {
    type: "message",
    message: secret,
    toolCalls: [
      {
        toolCallId: "t",
        toolName: "executeCode",
        input: secret,
        output: secret,
      },
    ],
  });
  const request = "b7f07bca-d7da-408b-869a-1b882090c735";
  put("chatModelData:a0.a1", {
    chatId: 0,
    sequence: 1,
    osDashboardRequestId: request,
    message: {
      role: "assistant",
      responseId: "provider-not-gateway",
      model: "requested-model",
      responseModel: "served-model",
      timestamp: 1001,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "t", name: "executeCode" }],
      usage: {
        input: 10,
        output: 3,
        cacheRead: 4,
        cacheWrite: 1,
        totalTokens: 18,
        cost: { total: 0.03 },
      },
    },
  });
  message(2, {
    type: "connectionRequest",
    vendorId: "agent-spawner",
    state: "pending",
    reason: secret,
  });
  const action = {
    id: 1,
    type: "action",
    caller: { from: "agent", chatId: 0 },
    createdAt: new Date(1003),
    state: "pending",
    description: {
      description: secret,
      actionKind: { tag: "document.write", label: secret },
    },
  };
  put("actions:a1", action);
  const untrusted = join(objectsDir, "workshop-backend-UserDurableObject");
  mkdirSync(untrusted);
  new DatabaseSync(join(untrusted, "b".repeat(64) + ".sqlite")).close();
  const outputFile = join(dir, "audit", "workshop.sqlite");
  const exportDb = openProjection({ objectsDir, outputFile });
  const view = () => new DatabaseSync(outputFile, { readOnly: true });
  try {
    assert.equal(exportDb.refresh().failed, 0);
    assert.equal(exportDb.refresh().scanned, 0);
    let db = view();
    assert.equal(
      db.prepare("SELECT initiator FROM chat").get().initiator,
      "member@example.test",
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM chat_event WHERE type='approval' AND status='pending'",
        )
        .get().n,
      2,
    );
    assert.equal(
      db.prepare("SELECT cost_usd FROM chat_event WHERE type='model'").get()
        .cost_usd,
      0.03,
    );
    db.close();
    source.exec(
      "CREATE TABLE os_dashboard_model_call(request_id TEXT PRIMARY KEY,chat_id INTEGER,ts INTEGER,model TEXT,operation TEXT,status INTEGER)",
    );
    source
      .prepare("INSERT INTO os_dashboard_model_call VALUES(?,?,?,?,?,?)")
      .run(request, 0, 1001, "requested-model", "chat", 200);
    source
      .prepare("INSERT INTO os_dashboard_model_call VALUES(?,?,?,?,?,?)")
      .run(
        "59e20e15-24aa-4e56-9a88-0fa86dd65b6f",
        0,
        1002,
        "quick-model",
        "thread-title",
        503,
      );
    message(2, {
      type: "connectionRequest",
      vendorId: "agent-spawner",
      state: "accepted",
      reason: secret,
    });
    put("actions:a1", {
      ...action,
      state: "approved",
      appliedAt: new Date(1012),
      autoApproved: true,
      resolvedBy: user,
    });
    assert.equal(exportDb.refresh().failed, 0);
    db = view();
    const rows = db.prepare("SELECT * FROM chat_event").all();
    const models = rows.filter((e) => e.type === "model");
    assert.equal(models.length, 2);
    assert.deepEqual(
      models
        .filter((e) => e.request_id === request)
        .map((e) => [
          e.served_model,
          e.input_tokens,
          e.output_tokens,
          e.cost_usd,
        ]),
      [["served-model", 15, 3, null]],
    );
    assert.ok(
      models.some(
        (e) => e.operation === "thread-title" && e.status === "http_error",
      ),
    );
    assert.ok(
      rows.some(
        (e) =>
          e.type === "tool" &&
          e.name === "executeCode" &&
          e.status === "executed",
      ),
    );
    assert.ok(
      rows.some(
        (e) =>
          e.type === "approval" &&
          e.status === "auto_approved" &&
          e.actor === "member@example.test",
      ),
    );
    assert.ok(
      rows.some(
        (e) =>
          e.type === "approval" && e.status === "approved" && e.actor === null,
      ),
    );
    assert.ok(!readFileSync(outputFile).includes(Buffer.from(secret)));
    db.close();
  } finally {
    exportDb.close();
    source.close();
  }
});

test("opens before Workshop, handles history rewind, and removes deleted chats and objects", async (t) => {
  const { openProjection } = await import("../export.mjs");
  const dir = mkdtempSync(join(tmpdir(), "os-dashboard-rewind-"));
  const objectsDir = join(dir, "objects"),
    outputFile = join(dir, "audit", "workshop.sqlite");
  const app = openProjection({ objectsDir, outputFile });
  t.after(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(app.refresh(), { scanned: 0, failed: 0 });
  const ns = join(objectsDir, "workshop-backend-OverseerDurableObject"),
    file = join(ns, "c".repeat(64) + ".sqlite");
  mkdirSync(ns, { recursive: true });
  const source = new DatabaseSync(file);
  source.exec("CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB)");
  const put = (key, obj) =>
    source
      .prepare("INSERT OR REPLACE INTO _cf_KV VALUES(?,?)")
      .run(key, serialize(obj));
  const meta = { started: new Date(20), lastActive: new Date(40) };
  put("chatMeta:a1", {
    ...meta,
    id: 1,
    startedBy: { type: "gadget", id: "spawner/66" },
  });
  put("chatMeta:a2", { ...meta, id: 2 });
  put("chats:a1.a0", {
    type: "message",
    sequence: 0,
    chatId: 1,
    timestamp: 30,
    author: { type: "user", id: "other-user" },
  });
  put("chats:a1.a1", {
    type: "webFetchRequest",
    sequence: 1,
    chatId: 1,
    timestamp: 31,
    state: "approved",
    decidedBy: "authorized-member",
  });
  put("chats:a2.a0", {
    type: "message",
    sequence: 0,
    chatId: 2,
    timestamp: 21,
    author: { type: "agent", id: "model" },
  });
  put("chats:a2.a1", {
    type: "message",
    sequence: 1,
    chatId: 2,
    timestamp: 22,
    author: { type: "user", id: "late-member" },
  });
  assert.equal(app.refresh().failed, 0);
  const out = new DatabaseSync(outputFile, { readOnly: true });
  try {
    assert.deepEqual(
      out
        .prepare("SELECT initiator FROM chat ORDER BY chat_id")
        .all()
        .map((c) => c.initiator),
      ["spawner/66", null],
    );
    assert.equal(
      out.prepare("SELECT actor FROM chat_event WHERE type='approval'").get()
        .actor,
      "authorized-member",
    );
    source.exec(
      "DELETE FROM _cf_KV WHERE key='chats:a1.a1' OR key='chatMeta:a2'",
    );
    assert.equal(app.refresh().failed, 0);
    assert.equal(
      out
        .prepare(
          "SELECT count(*) n FROM chat_event WHERE type='approval' OR chat_id=2",
        )
        .get().n,
      0,
    );
    source.close();
    rmSync(file);
    assert.equal(app.refresh().failed, 0);
    assert.equal(out.prepare("SELECT count(*) n FROM chat").get().n, 0);
  } finally {
    out.close();
  }
});
