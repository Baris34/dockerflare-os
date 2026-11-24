// Runs on the private Docker network, with no published port. Only the fixture's synthetic
// key is accepted. A final answer proves the expected tool result reached the second POST.
import { createServer } from "node:http";

const contextCode = `export default async function(self, env) {
  const catalog = await env.CONTEXT.list();
  const collection = catalog.entries.find(entry => entry.title === "Smoke collection");
  const listing = await env.CONTEXT.list({ collectionId: collection.id });
  const doc = await env.CONTEXT.read(listing.entries.find(entry => entry.path === "proof.md").docId);
  console.log(doc.content);
}`;

const scheduleCode = `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  const callback = await env.ALARM_PROBE.rpc[restore]({ type: "alarm" });
  const id = await env.SCHEDULER.runAt(Date.now() + 60_000, callback, {
    title: "Smoke alarm", description: "Save the delivered run ID in the gadget."
  });
  console.log("registered " + id);
}`;

function sendStream(res, model, initialDelta, finishReason) {
  const chunk = { id: "fixture", model, created: 1, object: "chat.completion.chunk" };
  const event = (delta, finish_reason) => "data: " + JSON.stringify({
    ...chunk, choices: [{ index: 0, delta, finish_reason }],
  }) + "\n\n";
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(event(initialDelta, null));
  res.end(event({}, finishReason) + "data: [DONE]\n\n");
}

let webFetchReachedModel = false;
const server = createServer(async (req, res) => {
  try {
    if (req.url !== "/team/v1/chat/completions" || req.method !== "POST") {
      if (req.method === "GET" && req.url === "/team/v1") webFetchReachedModel = true;
      res.writeHead(404).end();
      return;
    }
    let data = "";
    for await (const part of req) data += part;
    const { model, stream, messages, tools } = JSON.parse(data);
    const keyed = model === "alias-keyed";
    if ((!keyed && model !== "alias-no-key") || stream !== true) throw Error("wrong model or stream flag");
    if (req.headers.authorization !== (keyed ? "Bearer docker-smoke-fixture" : undefined)) {
      throw Error("incorrect authorization header");
    }
    const text = content => sendStream(res, model, { role: "assistant", content }, "stop");
    // Title suggestions use the same endpoint but never consume an agent step.
    if (messages.length === 1 && messages[0].role === "user" && !tools?.length) {
      text("Docker smoke");
      return;
    }
    const id = keyed ? "schedule-probe" : "read-context";
    const result = messages.find(m => m.role === "tool" && m.tool_call_id === id);
    if (result) {
      if (!messages.some(m => m.role === "assistant" && m.tool_calls?.some(call => call.id === id))) {
        throw Error("assistant tool call missing from continuation");
      }
      const expected = keyed ? "registered " : "Document read through Context";
      if (!String(result.content).includes(expected)) throw Error("wrong executeCode result");
      if (!keyed) {
        const denial = messages.find(m => m.role === "tool" && m.tool_call_id === "web-fetch");
        if (!denial?.content || webFetchReachedModel) {
          throw Error("webFetch reached the private model listener or omitted its result");
        }
      }
      text(keyed ? "Alarm registered." : "Context document verified.");
      return;
    }
    if (!tools?.some(tool => tool.function.name === "executeCode")) throw Error("executeCode missing");
    const calls = [{
      index: 0, id, type: "function",
      function: { name: "executeCode", arguments: JSON.stringify({ code: keyed ? scheduleCode : contextCode }) },
    }];
    if (!keyed) calls.push({
      index: 1, id: "web-fetch", type: "function",
      function: { name: "webFetch", arguments: JSON.stringify({ url: "https://model:8000/team/v1" }) },
    });
    sendStream(res, model, { role: "assistant", tool_calls: calls }, "tool_calls");
  } catch (err) {
    console.error(err.message);
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: err.message } }));
  }
});
// Inference uses plain HTTP on the private network. A TLS ClientHello here would prove that
// the general HTTPS webFetch opened a connection to the very same private host and port,
// even if certificate verification or the protocol mismatch subsequently caused an error.
server.on("clientError", (error, socket) => {
  if (error.rawPacket?.[0] === 0x16) webFetchReachedModel = true;
  socket.destroy();
});
server.listen(Number(process.env.PORT ?? 8000), "0.0.0.0");
