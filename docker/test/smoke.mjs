// From a checkout with its pnpm dependencies installed and the two images already built:
// node docker/test/smoke.mjs [web-image] [workshop-image]
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

const path = local => fileURLToPath(new URL(local, import.meta.url));
execFileSync(process.execPath, [path("../../packages/api-schema/scripts/generate.ts"), "--if-stale"], { stdio: "inherit" });
const { modelBase, seed, until, verifyPersisted } = await import("./workshop-session.mjs");
const [, , webTag = "dockerflare/web:local", workshopTag = "dockerflare/workshop:local"] = process.argv;
const prefix = "workshop-smoke-" + randomUUID();
const name = role => prefix + "-" + role;
const docker = (...args) => execFileSync("docker", args, {
  encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"],
}).trim();
// A tag can be rebuilt while the test waits for an alarm. Recreate each service from the
// exact image the test started with.
const webImage = docker("image", "inspect", "-f", "{{.Id}}", webTag);
const workshopImage = docker("image", "inspect", "-f", "{{.Id}}", workshopTag);
const cleanup = [];

function own(remove, ...create) {
  docker(...create);
  cleanup.unshift(remove);
}

function startWorkshop(origin, volume) {
  docker("run", "-d", "--name", name("workshop"), "--network", prefix, "--network-alias", "workshop",
    "-v", volume + ":/data", "-e", 'ADMINS=["smokeadmin"]', "-e", "PUBLIC_BASE_URL=" + origin,
    "-e", "SELF_HOSTED_MODEL_BASE_URLS=" + JSON.stringify([modelBase]), workshopImage);
  assert.equal(docker("port", name("workshop")), "");
}

async function ready(origin) {
  let lastReply = "no HTTP response";
  let state;
  await until(() => "Router via nginx (Workshop " + state + ", /api/version: " + lastReply + ")", async () => {
    state = docker("inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", name("workshop"));
    if (!state.startsWith("running ")) {
      const logs = spawnSync("docker", ["logs", "--tail", "15", name("workshop")], {
        encoding: "utf8", maxBuffer: 32_768, timeout: 5_000,
      });
      // Emit only known boot diagnoses. Arbitrary container log lines can include URLs or secrets.
      const tail = logs.stdout + logs.stderr;
      const reason = tail.includes("No CA certificates were loaded") ? "No system CA certificates loaded."
        : "Run the image in the foreground to inspect its startup diagnostics.";
      throw Error("Workshop stopped during boot (" + state + "). " + reason);
    }
    try {
      const reply = await fetch(origin + "/api/version", { signal: AbortSignal.timeout(3_000) });
      lastReply = "HTTP " + reply.status;
      return reply.ok && Object.hasOwn(await reply.json(), "version");
    } catch { return false; }
  });
}

async function checkWeb(origin) {
  assert.equal((await (await fetch(origin + "/healthz")).text()).trim(), "ok");
  const html = await (await fetch(origin)).text();
  assert.match(html, /<script[^>]+src=/);
  assert.equal(await (await fetch(origin + "/gatekeepers/context/collections/example/files/proof.md")).text(), html);
  const mainScript = html.match(/<script\b[^>]*\bsrc="([^"]+)"/)[1];
  const script = await fetch(new URL(mainScript, origin));
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  const pdfModule = docker("exec", name("web"), "ls", "/usr/share/nginx/html/assets")
    .split("\n").find(file => /^pdf\.worker.*\.mjs$/.test(file));
  assert.ok(pdfModule, "missing built PDF worker");
  const pdf = await fetch(origin + "/assets/" + pdfModule, { method: "HEAD" });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("content-type"), /javascript/);
  for (const route of ["/assets/missing.js", "/icons/missing.png", "/pdfjs/missing.wasm", "/blueprint-screenshot/missing", "/api/missing"]) {
    assert.equal((await fetch(origin + route)).status, 404, route);
  }
  const gatekeeper = await fetch(origin + "/gatekeeper/context/missing");
  assert.equal(gatekeeper.status, 200);
  assert.equal(await gatekeeper.text(), "Context Library worker is running.");
}

// The TLS terminator forwards to web over HTTP. Use the native HTTP client to send the
// external Host exactly as a reverse proxy would, while connecting only to the loopback port.
function clientErrorStatus(origin, publicHost, browserScheme) {
  return new Promise((resolve, reject) => {
    const req = request(new URL("/api/client-errors", origin), {
      method: "POST",
      headers: {
        host: publicHost, origin: browserScheme + "://" + publicHost,
        "content-type": "application/json", "X-Workshop-External-Https": "http",
      },
    }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

// Keep a generous bound for cold startup and alarm delivery, including stalled WebSocket calls.
let timer;
try {
  own(["network", "rm", prefix], "network", "create", prefix);
  for (const role of ["data", "backup", "restored"]) {
    own(["volume", "rm", name(role)], "volume", "create", name(role));
  }
  own(["rm", "-f", name("web")], "run", "-d", "--name", name("web"), "--network", prefix,
    "-p", "127.0.0.1::8080", webImage);
  const origin = "http://" + docker("port", name("web"), "8080/tcp");
  // Copy the fixture into its container so it needs no writable source mount.
  own(["rm", "-fv", name("model")], "create", "--name", name("model"), "--network", prefix,
    "--network-alias", "model", "--entrypoint", "node", workshopImage, "/tmp/model-fixture.mjs");
  docker("cp", path("./model-fixture.mjs"), name("model") + ":/tmp/model-fixture.mjs");
  docker("start", name("model"));
  assert.equal(docker("port", name("model")), "");
  startWorkshop(origin, name("data"));
  cleanup.unshift(["rm", "-f", name("workshop")]);

  const run = async () => {
    await ready(origin);
    await checkWeb(origin);
    const state = await seed(origin);
    console.log("Verified web, admin login, blueprint gadget and two streamed tool round trips.");
    docker("stop", name("workshop"));
    assert.ok(Date.now() < state.nextFire, "the alarm was already due when Workshop stopped");
    const syntheticCode = "smoke-oauth-" + randomUUID();
    const failed = await fetch(origin + "/gatekeeper/context/oauth?code=" + syntheticCode);
    assert.equal(failed.status, 502);
    const logs = spawnSync("docker", ["logs", name("web")], { encoding: "utf8", timeout: 5_000 });
    assert.equal(logs.status, 0);
    assert.ok(!(logs.stdout + logs.stderr).includes(syntheticCode), "nginx logged the synthetic OAuth code");
    docker("stop", name("model"));
    docker("rm", name("workshop"));
    startWorkshop(origin, name("data"));
    await ready(origin);
    await checkWeb(origin);
    await verifyPersisted(origin, state);
    console.log("Verified recreated Workshop and scheduled callback with the model offline.");

    docker("stop", name("workshop"));
    docker("rm", name("workshop"));
    // Two independent invocations, exactly one data volume mounted in each.
    docker("run", "--rm", "--network", "none", "-v", name("data") + ":/data:ro",
      "-v", name("backup") + ":/backup", "--user", "0", "--entrypoint", "tar",
      workshopImage, "-C", "/data", "-cf", "/backup/workshop.tar", ".");
    docker("run", "--rm", "--network", "none", "-v", name("restored") + ":/data",
      "-v", name("backup") + ":/backup:ro", "--user", "0", "--entrypoint", "tar",
      workshopImage, "-C", "/data", "-xf", "/backup/workshop.tar");
    startWorkshop(origin, name("restored"));
    await ready(origin);
    await verifyPersisted(origin, state);
    console.log("Verified fresh-volume restore, chat history, model, Docs, Context and alarm state.");
    docker("stop", name("workshop"));
    docker("rm", name("workshop"));
    const publicHost = "workshop.example.org";
    startWorkshop("https://" + publicHost, name("restored"));
    await ready(origin);
    assert.equal(await clientErrorStatus(origin, publicHost, "https"), 204);
    assert.equal(await clientErrorStatus(origin, publicHost, "http"), 403);
    console.log("Verified the configured public HTTPS origin survives TLS termination and a conflicting client header.");
  };
  await Promise.race([run(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("Docker smoke exceeded 8 minutes")), 480_000);
  })]);
} finally {
  clearTimeout(timer);
  for (const cmd of cleanup) {
    try { docker(...cmd); }
    catch (err) {
      console.error("Fixture cleanup:", err.stderr?.trim() ?? err.message);
      process.exitCode = 1;
    }
  }
}
