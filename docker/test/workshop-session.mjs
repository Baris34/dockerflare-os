import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { passwordHash, USER_AGENT, webSocketConnection } from "../../packages/api-cli/src/session.ts";
import { table } from "../../packages/api-cli/generated/commands.ts";

export const modelBase = "http://model:8000/team/v1";
const admin = "smokeadmin";
const markdown = "Written to a real Docs gadget before recreation.";
const contextBody = "Document read through Context";

const alarmGadget = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  [restore](params) {
    if (params.type !== "alarm") throw Error("Unknown callback");
    return new Alarm(this.ctx.storage);
  }
  lastRun() { return this.ctx.storage.get("runId"); }
}
class Alarm extends RpcTarget {
  constructor(storage) { super(); this.storage = storage; }
  async onSchedule(event) { await this.storage.put("runId", event.runId); }
}`;

/** Poll only eventual state; unexpected API failures surface immediately. */
export async function until(label, read, timeout = 90_000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(500);
  } while (Date.now() < end);
  throw Error("Timed out waiting for " + (typeof label === "function" ? label() : label));
}

function connect(origin, cli = false) {
  const url = new URL("/api?smoke=1", origin);
  url.protocol = "ws:";
  const headers = { Origin: origin };
  if (cli) headers["User-Agent"] = USER_AGENT;
  return webSocketConnection(url.href, headers).main;
}

async function chat(ws, model, label, expected) {
  const id = await ws.newChat(label, model);
  const result = await ws.waitForAgent(id);
  assert.equal(result?.type, "message", "agent did not finish: " + (result?.message ?? result?.type));
  assert.equal(result.message, expected);
  return id;
}

async function archiveHash(browser, id) {
  const archive = await browser.downloadBlueprint(id);
  return createHash("sha256").update(new Uint8Array(await new Response(archive).arrayBuffer())).digest("hex");
}

/** Exercise the web-origin signup flow, then the admin-only CLI WebSocket policy. */
export async function seed(origin) {
  const hash = await passwordHash(admin, randomUUID(), table.constants.SERVICE_SALT);
  using browser = connect(origin);
  assert.equal((await browser.getServerConfig()).signupsEnabled, true);
  const token = await browser.createAccount(admin, "Smoke admin", hash);
  assert.equal(typeof token, "string");
  using cli = connect(origin, true);
  await assert.rejects(Promise.resolve(cli.getServerConfig()), /limited to deployment admins/);
  const userToken = await browser.createAccount("smokeuser", "Smoke user", hash);
  await assert.rejects(Promise.resolve(cli.authenticate(userToken)), /limited to deployment admins/);
  using api = await cli.authenticate(await cli.login(admin, hash));
  assert.equal(await api.amIAdmin(), true);

  for (const vendor of ["context", "scheduler"]) await api.provisionAmbientAccount(vendor);
  using context = (await api.getGatekeeperApp("context")).ui;
  const collection = await context.createContextCollection("Smoke collection", "Docker acceptance", "private");
  await context.putContextDocument(collection.id, "proof.md", { description: "Smoke proof", body: contextBody });

  for (const [id, apiUrl, apiToken] of [
    ["alias-no-key", modelBase + "/", ""], ["alias-keyed", modelBase, "docker-smoke-fixture"],
  ]) {
    await api.addModel({ type: "agent", id, name: id }, {
      provider: "openai-compatible", model: id, apiUrl, apiToken,
    });
  }
  const format = await until("bundled Docs blueprint", async () =>
    (await api.listOutputFormats()).find(offer => offer.output.id === "document"));
  using ws = await api.newWorkspaceFromBlueprint(format.blueprintId, {});
  const { id: workspace, defaultGadgetId: doc } = await ws.getMetadata();
  using gadget = await ws.getGadget(doc);
  using document = await gadget.connectToGadget();
  await document.setMarkdown({ markdown });
  assert.equal((await document.getMarkdown()).trim(), markdown);
  const blueprint = await gadget.createBlueprint("Smoke starter", "A user-published blueprint");
  await until("custom blueprint in KV", () => browser.getBlueprint(blueprint.id));
  const archive = await archiveHash(browser, blueprint.id);

  const edit = await ws.newChat("Install the alarm receiver.", null);
  using alarm = await ws.createGadget("Alarm receiver", edit, "ALARM_PROBE");
  const receiver = await alarm.getId();
  await ws.submitCodeChange(edit, {
    clientId: randomUUID(), seq: 1, generation: 0, revision: 0,
    change: { [receiver]: [["server.js", { set: alarmGadget }]] },
  });
  assert.equal((await ws.mergeChanges(edit)).outcome, "merged");

  const contextChat = await chat(ws, "alias-no-key", "Read the Context document.", "Context document verified.");
  const alarmChat = await chat(ws, "alias-keyed", "Register the alarm.", "Alarm registered.");
  const hooks = await ws.listHooks();
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].enabled, false);
  assert.equal(hooks[0].gadgetId, receiver);
  await ws.enableHook(hooks[0].id);
  using scheduler = (await api.getGatekeeperApp("scheduler")).ui;
  const { schedules } = await scheduler.list();
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].status, "active");
  return {
    hash, workspace, doc, receiver, contextChat, alarmChat, collection: collection.id,
    blueprint: blueprint.id, archive, schedule: schedules[0].scheduleId, nextFire: schedules[0].nextFire,
  };
}

export async function verifyPersisted(origin, state) {
  using browser = connect(origin);
  using api = await browser.authenticate(await browser.login(admin, state.hash));
  assert.equal(await api.amIAdmin(), true);
  const keyed = await api.getModelConfig("alias-keyed");
  assert.equal(keyed.config.apiToken, null);
  assert.equal(keyed.config.apiUrl, modelBase);
  using ws = await api.openWorkspace(state.workspace);
  assert.equal((await browser.getBlueprint(state.blueprint)).metadata.title, "Smoke starter");
  assert.equal(await archiveHash(browser, state.blueprint), state.archive);
  using gadget = await ws.getGadget(state.doc);
  using document = await gadget.connectToGadget();
  assert.equal((await document.getMarkdown()).trim(), markdown);
  for (const [id, expected] of [[state.contextChat, "Context document verified."], [state.alarmChat, "Alarm registered."]]) {
    const { messages } = await ws.getChatHistory(id);
    assert.ok(messages.some(m => m.type === "message" && m.author.type === "agent" && m.message === expected));
  }
  using context = (await api.getGatekeeperApp("context")).ui;
  assert.equal((await context.getContextDocument(state.collection, "proof.md")).body, contextBody);
  using scheduler = (await api.getGatekeeperApp("scheduler")).ui;
  await until("alarm delivery after Workshop recreation", async () => {
    const row = (await scheduler.list()).schedules.find(schedule => schedule.scheduleId === state.schedule);
    assert.ok(row && (row.status === "active" || row.status === "completed"), "unexpected schedule status: " + row?.status);
    return row.status === "completed";
  }, 120_000);
  using alarm = await ws.getGadget(state.receiver);
  using receiver = await alarm.connectToGadget();
  assert.equal(typeof await receiver.lastRun(), "string");
}
