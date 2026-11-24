import { closeSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import {
  actionDecision,
  decisionCard,
  identifier,
  integer,
  modelEvent,
  positive,
  requestId,
  time,
  toolEvents,
} from "./records.mjs";

const namespace = "workshop-backend-OverseerDurableObject";
const eventFields = [
  "event_id",
  "type",
  "ts",
  "name",
  "actor",
  "status",
  "request_id",
  "operation",
  "http_status",
  "served_model",
  "requested_model",
  "input_tokens",
  "output_tokens",
  "cost_usd",
  "cost_source",
  "source_seq",
  "action_id",
];
function numberKey(n) {
  const digits = n.toString(16);
  return String.fromCharCode(96 + digits.length) + digits;
}
function keyNumber(key) {
  if (typeof key !== "string" || !/^[a-n][0-9a-f]+$/.test(key)) return null;
  const n = parseInt(key.slice(1), 16);
  return integer(n) !== null && numberKey(n) === key ? n : null;
}
function fileStamp(path) {
  const s = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!s) return "-";
  if (!s.isFile()) throw new Error("Unsupported source file.");
  // SQLite may touch WAL permissions even when opening the database read-only. The WAL
  // ctime then changes on every read, while its content mtime changes only on actual writes.
  const fields = [s.dev, s.ino, s.size, s.mtimeNs];
  if (!path.endsWith("-wal")) fields.push(s.ctimeNs);
  if (path.endsWith(".sqlite")) {
    // Two rollback-journal commits can share both size and filesystem timestamps.
    // The file change counter in the SQLite header distinguishes those commits.
    const header = Buffer.alloc(4);
    const fd = openSync(path, "r");
    try {
      if (readSync(fd, header, 0, 4, 24) === 4) fields.push(header.readUInt32BE());
    } finally {
      closeSync(fd);
    }
  }
  return fields.join("/");
}
function decode(bytes) {
  // workerd's _cf_KV stores V8 structured clones. Only the four explicitly selected typed collections enter here.
  return deserialize(bytes);
}
function openOutput(file) {
  const db = new DatabaseSync(file);
  try {
    // A read-only panel volume requires no writable WAL/shm files in DELETE mode.
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;",
    );
    db.exec(
      [
        "CREATE TABLE IF NOT EXISTS chat(workspace_id TEXT NOT NULL,chat_id INTEGER NOT NULL,started_at INTEGER,initiator TEXT,updated_at INTEGER,initiator_type TEXT,workshop_total_cost_usd REAL,last_error_at INTEGER,PRIMARY KEY(workspace_id,chat_id))",
        "CREATE TABLE IF NOT EXISTS chat_event(workspace_id TEXT NOT NULL,chat_id INTEGER NOT NULL,event_id TEXT NOT NULL,type TEXT NOT NULL,ts INTEGER,name TEXT,actor TEXT,status TEXT,request_id TEXT,operation TEXT,http_status INTEGER,served_model TEXT,requested_model TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_usd REAL,cost_source TEXT,source_seq INTEGER,action_id INTEGER,PRIMARY KEY(workspace_id,chat_id,event_id),FOREIGN KEY(workspace_id,chat_id) REFERENCES chat ON DELETE CASCADE)",
        "CREATE INDEX IF NOT EXISTS event_time ON chat_event(workspace_id,chat_id,ts)",
        "CREATE INDEX IF NOT EXISTS event_request ON chat_event(request_id) WHERE request_id IS NOT NULL",
        "CREATE TABLE IF NOT EXISTS export_workspace(workspace_id TEXT PRIMARY KEY,stamp TEXT,last_action INTEGER NOT NULL DEFAULT -1,ledger_row INTEGER NOT NULL DEFAULT 0)",
        "CREATE TABLE IF NOT EXISTS export_chat(workspace_id TEXT,chat_id INTEGER,last_seq INTEGER,PRIMARY KEY(workspace_id,chat_id),FOREIGN KEY(workspace_id,chat_id) REFERENCES chat ON DELETE CASCADE)",
        "COMMIT",
      ].join(";"),
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function project(source, dest, ws, stamp) {
  let state = dest
    .prepare("SELECT * FROM export_workspace WHERE workspace_id=?")
    .get(ws);
  const hasTable = (name) =>
    !!source
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
      .get(name);
  const ledgerTable = hasTable("os_dashboard_model_call") ? "os_dashboard_model_call" : hasTable("seyir_model_call") ? "seyir_model_call" : null;
  if (!hasTable("_cf_KV")) {
    forget(dest, ws);
    return;
  }
  if (state) {
    const tail = source.prepare(
      "SELECT key FROM _cf_KV WHERE key>? AND key<? ORDER BY key DESC LIMIT 1",
    );
    const highWater = dest.prepare(
      "SELECT chat_id,last_seq FROM export_chat WHERE workspace_id=?",
    );
    const rewound = highWater.all(ws).some(({ chat_id, last_seq }) => {
      const prefix = "chats:" + numberKey(chat_id) + ".";
      const key = tail.get(prefix, prefix.slice(0, -1) + "/")?.key;
      return (
        last_seq > (key ? (keyNumber(key.slice(prefix.length)) ?? -1) : -1)
      );
    });
    // A restored file, truncated history or rewound ledger invalidates all cursors for this workspace.
    if (
      rewound ||
      state.stamp.split("/").slice(0, 2).join("/") !==
        stamp.split("/").slice(0, 2).join("/") ||
      (state.ledger_row > 0 &&
        (!ledgerTable ||
          source
            .prepare(`SELECT coalesce(max(rowid),0) n FROM ${ledgerTable}`)
            .get().n < state.ledger_row))
    ) {
      forget(dest, ws);
      state = null;
    }
  }
  const rangeSql =
    "SELECT key,value FROM _cf_KV WHERE key>? AND key<? ORDER BY key";
  const range = source.prepare(rangeSql),
    messages = source.prepare(rangeSql);
  const point = source.prepare("SELECT value FROM _cf_KV WHERE key=?");
  const get = (key) => {
    const result = point.get(key);
    return result && decode(result.value);
  };
  const event = dest.prepare(
    "INSERT OR REPLACE INTO chat_event(workspace_id,chat_id," +
      eventFields.join(",") +
      ") VALUES(" +
      Array(eventFields.length + 2)
        .fill("?")
        .join(",") +
      ")",
  );
  function write(chat, record) {
    if (record)
      event.run(ws, chat, ...eventFields.map((k) => record[k] ?? null));
  }
  const chats = new Set();
  const metadata = dest.prepare(
    "INSERT INTO chat(workspace_id,chat_id,started_at,updated_at,workshop_total_cost_usd) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(workspace_id,chat_id) DO UPDATE SET started_at=excluded.started_at,updated_at=excluded.updated_at,workshop_total_cost_usd=excluded.workshop_total_cost_usd",
  );
  const cursors = dest.prepare(
    "SELECT last_seq FROM export_chat WHERE workspace_id=? AND chat_id=?",
  );
  const saveCursor = dest.prepare(
    "INSERT OR REPLACE INTO export_chat VALUES(?,?,?)",
  );
  const assign = dest.prepare(
    "UPDATE chat SET initiator=?,initiator_type=? WHERE workspace_id=? AND chat_id=? AND initiator IS NULL",
  );
  const lastError = dest.prepare(
    "UPDATE chat SET last_error_at=? WHERE workspace_id=? AND chat_id=?",
  );
  for (const { key, value } of range.iterate("chatMeta:", "chatMeta;")) {
    const id = keyNumber(key.slice("chatMeta:".length));
    if (id === null) continue;
    const meta = decode(value);
    if (meta.id !== id) continue;
    chats.add(id);
    metadata.run(
      ws,
      id,
      time(meta.started),
      time(meta.lastActive),
      positive(meta.totalCost),
    );
    const starter = meta.startedBy;
    if (
      ["user", "agent", "gadget"].includes(starter?.type) &&
      identifier(starter.id)
    )
      dest
        .prepare(
          "UPDATE chat SET initiator=?,initiator_type=? WHERE workspace_id=? AND chat_id=?",
        )
        .run(identifier(starter.id), starter.type, ws, id);
    const previous = cursors.get(ws, id);
    let last = previous?.last_seq ?? -1;
    const prefix = "chats:" + numberKey(id) + ".";
    for (const entry of messages.iterate(
      prefix + (last < 0 ? "" : numberKey(last)),
      prefix.slice(0, -1) + "/",
    )) {
      const row = decode(entry.value),
        seq = keyNumber(entry.key.slice(prefix.length));
      if (seq === null || row.sequence !== seq || row.chatId !== id) continue;
      if (
        seq === 0 &&
        ["message", "slashCommand", "agentCallback"].includes(row.type) &&
        ["user", "gadget"].includes(row.author?.type) &&
        identifier(row.author.id)
      )
        assign.run(identifier(row.author.id), row.author.type, ws, id);
      last = seq;
      if (row.type === "error") lastError.run(time(row.timestamp), ws, id);
      if (row.type === "message" && row.author?.type === "agent") {
        const snapshot = get(
          "chatModelData:" + numberKey(id) + "." + numberKey(seq),
        );
        const model = modelEvent(row, snapshot);
        write(id, model);
        for (const tool of toolEvents(row, snapshot)) write(id, tool);
        // A ledger row can arrive before its successful step is committed. Restore its HTTP evidence
        // after writing the snapshot, even if the ledger cursor has already passed this row.
        if (model?.request_id && ledgerTable) {
          const ledger = source
            .prepare(
              `SELECT request_id,chat_id,ts,model,operation,status FROM ${ledgerTable} WHERE request_id=? AND chat_id=?`,
            )
            .get(model.request_id, id);
          if (ledger) nativeCall(ledger);
        }
      } else write(id, decisionCard(row));
    }
    if (!previous || last !== previous.last_seq) saveCursor.run(ws, id, last);
    const author = dest
      .prepare("SELECT initiator FROM chat WHERE workspace_id=? AND chat_id=?")
      .get(ws, id).initiator;
    write(id, {
      event_id: "start",
      type: "start",
      ts: time(meta.started),
      status: "started",
      actor: author,
    });
  }
  for (const { chat_id } of dest
    .prepare("SELECT chat_id FROM chat WHERE workspace_id=?")
    .all(ws))
    if (!chats.has(chat_id))
      dest
        .prepare("DELETE FROM chat WHERE workspace_id=? AND chat_id=?")
        .run(ws, chat_id);

  let actionId = state?.last_action ?? -1;
  for (const item of range.iterate(
    "actions:" + (actionId < 0 ? "" : numberKey(actionId)),
    "actions;",
  )) {
    const n = keyNumber(item.key.slice("actions:".length));
    if (n === null) continue;
    actionId = n;
    const action = decode(item.value);
    if (action.id === n && chats.has(action.caller?.chatId))
      write(action.caller.chatId, actionDecision(action));
  }
  // Accepted/denied cards and pending actions change in place, often without appending a chat message.
  for (const row of dest
    .prepare(
      "SELECT chat_id,source_seq,action_id FROM chat_event WHERE workspace_id=? AND type='approval' AND status='pending'",
    )
    .all(ws)) {
    if (row.action_id !== null) {
      const action = get("actions:" + numberKey(row.action_id));
      if (action?.caller?.chatId === row.chat_id)
        write(row.chat_id, actionDecision(action));
    } else {
      const card = get(
        "chats:" + numberKey(row.chat_id) + "." + numberKey(row.source_seq),
      );
      if (card?.chatId === row.chat_id) write(row.chat_id, decisionCard(card));
    }
  }
  function nativeCall(row) {
    const id = requestId(row.request_id),
      http = integer(row.status);
    if (
      !id ||
      !chats.has(row.chat_id) ||
      http === null ||
      http < 100 ||
      http > 599
    )
      return;
    const eventId = "request:" + id;
    const snapshot = dest
      .prepare(
        "SELECT * FROM chat_event WHERE workspace_id=? AND chat_id=? AND event_id=?",
      )
      .get(ws, row.chat_id, eventId);
    const model = identifier(row.model);
    write(row.chat_id, {
      ...snapshot,
      event_id: eventId,
      type: "model",
      name: snapshot?.served_model ?? model,
      requested_model: snapshot?.requested_model ?? model,
      ts: time(row.ts),
      status: http < 300 ? "http_ok" : "http_error",
      request_id: id,
      operation: identifier(row.operation),
      http_status: http,
      cost_usd: null,
      cost_source: null,
    });
  }
  let ledgerRow = state?.ledger_row ?? 0;
  if (ledgerTable) {
    for (const row of source
      .prepare(
        `SELECT rowid AS position,request_id,chat_id,ts,model,operation,status FROM ${ledgerTable} WHERE rowid>? ORDER BY rowid`,
      )
      .iterate(ledgerRow)) {
      nativeCall(row);
      ledgerRow = row.position;
    }
  }
  dest
    .prepare("INSERT OR REPLACE INTO export_workspace VALUES(?,?,?,?)")
    .run(ws, stamp, actionId, ledgerRow);
}
function forget(db, ws) {
  db.prepare("DELETE FROM chat WHERE workspace_id=?").run(ws);
  db.prepare("DELETE FROM export_workspace WHERE workspace_id=?").run(ws);
}

export function openProjection({
  objectsDir = "/data/objects",
  outputFile = "/os-dashboard-audit/workshop.sqlite",
} = {}) {
  objectsDir = resolve(objectsDir);
  outputFile = resolve(outputFile);
  if (outputFile === objectsDir || outputFile.startsWith(objectsDir + sep))
    throw new Error("Kaynak ve çıktı dizinleri ayrı olmalı.");
  mkdirSync(dirname(outputFile), { recursive: true });
  const sourceRoot = lstatSync(objectsDir, { throwIfNoEntry: false })
    ? realpathSync(objectsDir)
    : objectsDir;
  if (
    realpathSync(dirname(outputFile)).startsWith(sourceRoot + sep) ||
    realpathSync(dirname(outputFile)) === sourceRoot ||
    lstatSync(outputFile, { throwIfNoEntry: false })?.isSymbolicLink()
  )
    throw new Error("Projeksiyon yolu geçersiz.");
  const db = openOutput(outputFile);
  const ns = join(objectsDir, namespace);
  function refresh() {
    const count = { scanned: 0, failed: 0 };
    const directory = lstatSync(ns, { throwIfNoEntry: false });
    if (!directory) return count;
    if (!directory.isDirectory()) throw new Error("Geçersiz Overseer dizini.");
    const known = db.prepare(
      "SELECT stamp FROM export_workspace WHERE workspace_id=?",
    );
    const present = new Set();
    for (const file of readdirSync(ns, { withFileTypes: true })) {
      if (!file.isFile() || !/^[0-9a-f]{64}\.sqlite$/.test(file.name)) continue;
      const workspace = file.name.slice(0, -7),
        path = join(ns, file.name);
      present.add(workspace);
      let src;
      try {
        const wal = fileStamp(path + "-wal");
        const stamp = fileStamp(path) + "|" + wal;
        if (known.get(workspace)?.stamp === stamp) continue;
        fileStamp(path + "-shm"); // reject symlinks, but shared reader locks do not signal new content
        // An evicted workerd object has closed/checkpointed SQLite and removed its WAL. On a
        // physically read-only mount SQLite cannot recreate the empty WAL and SHM. Only this
        // checkpointed case uses immutable mode; validate both files again before publishing.
        const uri = pathToFileURL(path);
        if (wal === "-") uri.searchParams.set("immutable", "1");
        src = new DatabaseSync(wal === "-" ? uri.href : path, {
          readOnly: true,
        });
        src.exec(
          "PRAGMA busy_timeout=3000; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN",
        );
        db.exec("BEGIN IMMEDIATE");
        project(src, db, workspace, stamp);
        if (
          wal === "-" &&
          stamp !== fileStamp(path) + "|" + fileStamp(path + "-wal")
        )
          throw new Error("Kaynak okuma sırasında değişti.");
        db.exec("COMMIT");
        count.scanned++;
      } catch {
        if (db.isTransaction) db.exec("ROLLBACK");
        count.failed++;
      } finally {
        src?.close();
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of db
        .prepare("SELECT workspace_id FROM export_workspace")
        .all())
        if (!present.has(row.workspace_id)) forget(db, row.workspace_id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return count;
  }
  return { refresh, close: () => db.close() };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = openProjection({
    objectsDir: process.env.OS_DASHBOARD_WORKSHOP_OBJECTS,
    outputFile: process.env.OS_DASHBOARD_WORKSHOP_AUDIT_FILE,
  });
  const once = process.argv.includes("--once");
  function run() {
    try {
      const result = app.refresh();
      if (result.failed)
        console.error(
          "Workshop projeksiyonu okunamayan çalışma alanı sayısı",
          result.failed,
        );
      if (once) {
        console.log(JSON.stringify(result));
        process.exitCode = result.failed ? 1 : 0;
      }
    } catch {
      console.error("Workshop projeksiyonu güncellenemedi.");
      if (once) process.exitCode = 1;
    }
  }
  run();
  if (once) app.close();
  else {
    const interval = setInterval(run, 5000);
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        clearInterval(interval);
        app.close();
        process.exit(0);
      });
  }
}
