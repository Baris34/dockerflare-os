import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configuredModelApiRoots } from "../packages/workshop-shared/src/model-api-root.ts";

function jsonSetting(value, fallback, name) {
  if (value === undefined) return fallback;
  try { return JSON.parse(value); } catch { throw new Error(`Invalid JSON in ${name}`); }
}

function stringList(env, name) {
  const list = jsonSetting(env[name], [], name);
  if (!Array.isArray(list) || !list.every(item => typeof item === "string" && item.trim())) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return list;
}

export function deploymentOptions(env) {
  const url = new URL(env.PUBLIC_BASE_URL ?? "http://localhost:8080");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.href !== url.origin + "/") {
    throw new Error("PUBLIC_BASE_URL must be an HTTP(S) origin");
  }
  const roots = configuredModelApiRoots(env.SELF_HOSTED_MODEL_BASE_URLS);
  const vendors = (env.GATEKEEPERS ?? "context,scheduler").split(",").map(s => s.trim()).filter(Boolean);
  return {
    origin: url.origin, roots, vendors: [...new Set(vendors)],
    admins: stringList(env, "ADMINS"), env,
  };
}

// Only module paths baked into the image use Cap'n Proto's embed directive. Operator values are
// encoded as string literals even if they contain quotes, newlines or configuration syntax.
const modulePath = Symbol("module path");
const embed = path => ({ [modulePath]: path });

function literal(value) {
  if (value?.[modulePath]) return "embed " + JSON.stringify(value[modulePath]);
  if (Array.isArray(value)) return "[" + value.map(literal).join(", ") + "]";
  if (value !== null && typeof value === "object") {
    return "(" + Object.entries(value).map(([key, item]) => key + " = " + literal(item)).join(", ") + ")";
  }
  return JSON.stringify(value);
}

const json = value => JSON.stringify(value);
const kvTypes = { kv: "KVNamespaceObject", r2: "R2BucketObject" };

function storageServices(kind) {
  const className = kvTypes[kind], disk = kind + "-disk", object = kind + "-object";
  return [
    { name: disk, disk: { path: "/data/" + kind, writable: true } },
    {
      name: object, worker: {
        compatibilityDate: "2023-07-24", compatibilityFlags: ["nodejs_compat", "experimental"],
        modules: [{ name: kind + ".js", esModule: embed("/storage/" + kind + ".worker.js") }],
        durableObjectStorage: { localDisk: disk },
        durableObjectNamespaces: [{ className, uniqueKey: "storage-" + className, enableSql: true }],
        bindings: [{ name: "MINIFLARE_BLOBS", service: disk }],
      },
    }, {
      name: kind + "-entry", worker: {
        compatibilityDate: "2023-07-24",
        modules: [{ name: "entry.js", esModule: embed("/storage/object-entry.worker.js") }],
        bindings: [{ name: "MINIFLARE_OBJECT", durableObjectNamespace: { className, serviceName: object } }],
      },
    },
  ];
}

function storageBinding(name, kind, id) {
  return { name, [kind === "kv" ? "kvNamespace" : "r2Bucket"]: {
    name: kind + "-entry", props: { json: json({ MINIFLARE_NAMESPACE: id }) },
  } };
}

function appWorker(bundle, options, selectedVendors) {
  const { config, modules, mainModule } = bundle;
  const name = config.name;
  const bindings = (config.services ?? []).map(({ binding, service, entrypoint }) => ({
    name: binding, service: { name: service, ...(entrypoint && { entrypoint }) },
  }));
  const vars = { ...config.vars };
  if (name === "workshop-backend" || name === "router") {
    for (const vendor of selectedVendors) {
      const id = vendor.shortName ?? vendor.config.name.slice("gatekeeper-".length);
      bindings.push({
        name: "GATEKEEPER_" + id.toUpperCase().replaceAll("-", "_"),
        service: { name: vendor.config.name, ...(name === "workshop-backend" && {
          entrypoint: "GatekeeperVendor", ...(id === "context" && {
            props: { json: json({ sharingDomain: options.origin }) },
          }),
        }) },
      });
    }
  }
  if (name === "workshop-backend") {
    vars.PUBLIC_BASE_URL = options.origin;
    vars.ADMINS = options.admins;
    for (const key of ["AUTH_GATEKEEPERS", "DISABLE_PASSWORD_AUTH", "ADMIN_WORKSPACE_ACCESS_MAX",
      "ADMIN_AUDIT_RETENTION_MIN_DAYS", "ADMIN_WORKSPACE_WRITES"]) {
      if (options.env[key] !== undefined) vars[key] = options.env[key];
    }
    if (options.roots.length) {
      vars.SELF_HOSTED_MODEL_BASE_URLS = json(options.roots);
      if (options.env.OS_DASHBOARD_AI_GATEWAY_ROOT && options.roots.includes(options.env.OS_DASHBOARD_AI_GATEWAY_ROOT)) {
        vars.OS_DASHBOARD_AI_GATEWAY_ROOT = options.env.OS_DASHBOARD_AI_GATEWAY_ROOT;
      }
      bindings.push({ name: "SELF_HOSTED_MODEL", service: "model-transport" });
    }
  } else if (name.startsWith("gatekeeper-")) {
    const id = bundle.shortName ?? name.slice("gatekeeper-".length);
    const option = "GATEKEEPER_" + id.toUpperCase().replaceAll("-", "_") + "_CONFIG";
    const credentials = jsonSetting(options.env[option], {}, option);
    if (!credentials || Array.isArray(credentials) || typeof credentials !== "object" ||
        !Object.entries(credentials).every(([k,v]) => /^[A-Z][A-Z_0-9]*$/.test(k) && typeof v === "string")) {
      throw new Error(`${option} must be a JSON object of uppercase names and string values`);
    }
    Object.assign(vars, credentials);
    vars.BASE_URL = options.origin + "/gatekeeper/" + id;
    if (name === "gatekeeper-azure-repos") {
      if (!options.env.AZURE_DEVOPS_COLLECTION_URL) throw new Error("Set AZURE_DEVOPS_COLLECTION_URL for Azure Repos.");
      vars.AZURE_DEVOPS_COLLECTION_URL = options.env.AZURE_DEVOPS_COLLECTION_URL;
      if (options.env.AZURE_DEVOPS_API_VERSION) vars.AZURE_DEVOPS_API_VERSION = options.env.AZURE_DEVOPS_API_VERSION;
      bindings.push({ name: "AZURE_NETWORK", service: "azure-transport" });
    }
  }
  for (const [key, value] of Object.entries(vars)) {
    bindings.push(typeof value === "string" ? { name: key, text: value } : { name: key, json: json(value) });
  }
  for (const { binding, preview_id } of config.kv_namespaces ?? []) {
    bindings.push(storageBinding(binding, "kv", preview_id ?? (name + "-" + binding)));
  }
  for (const { binding, bucket_name } of config.r2_buckets ?? []) {
    bindings.push(storageBinding(binding, "r2", bucket_name));
  }
  for (const { binding } of config.worker_loaders ?? []) {
    bindings.push({ name: binding, workerLoader: { id: name + "-" + binding } });
  }
  // Keep namespace identity independent of image tags and optional gatekeeper ordering.
  const namespaces = [];
  for (const migration of config.migrations ?? []) {
    for (const className of migration.new_sqlite_classes ?? []) {
      namespaces.push({ className, uniqueKey: name + "-" + className, enableSql: true });
    }
    if (Object.keys(migration).some(k => k !== "tag" && k !== "new_sqlite_classes")) {
      throw new Error(`Unsupported Durable Object migration in ${name}: ${migration.tag}`);
    }
  }
  const fields = { esm: "esModule", text: "text", wasm: "wasm", data: "data" };
  if (!modules.some(m => m.name === mainModule)) throw new Error("Missing entry module for " + name);
  const ordered = modules.toSorted((a, b) => Number(b.name === mainModule) - Number(a.name === mainModule));
  return { name, worker: {
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags ?? [],
    modules: ordered.map(module => {
      const field = fields[module.type];
      if (!field) throw new Error("Unsupported Worker module type " + module.type);
      return { name: module.name, [field]: embed("/workers/" + name + "/" + module.name) };
    }),
    bindings, ...(namespaces.length && {
      durableObjectStorage: { localDisk: "objects-disk" }, durableObjectNamespaces: namespaces,
    }),
  } };
}

/** Services and capabilities available inside a single Workshop process. */
export function runtimeServices(bundles, options) {
  const vendors = options.vendors.map(id => {
    const bundle = bundles.find(b => b.config.name.startsWith("gatekeeper-") &&
        (b.shortName ?? b.config.name.slice("gatekeeper-".length)) === id);
    if (!bundle) throw new Error("Unavailable gatekeeper: " + id);
    return bundle;
  });
  const byName = new Map(bundles.map(b => [b.config.name, b]));
  const active = new Set(["router", "workshop-backend", ...vendors.map(b => b.config.name)]);
  for (const name of active) {
    if (!byName.has(name)) throw new Error("Missing Worker: " + name);
    for (const binding of byName.get(name).config.services ?? []) active.add(binding.service);
  }
  const services = [
    { name: "internet", network: { allow: ["public"], tlsOptions: { trustBrowserCas: true } } },
    { name: "objects-disk", disk: { path: "/data/objects", writable: true } },
    ...storageServices("kv"), ...storageServices("r2"),
    ...[...active].map(name => appWorker(byName.get(name), options, vendors)),
  ];
  if (options.roots.length) {
    services.push({
      name: "model-network", network: { allow: ["public", "private", "local"], tlsOptions: { trustBrowserCas: true } },
    }, {
      name: "model-transport", worker: {
        compatibilityDate: "2026-09-04",
        modules: [{ name: "model.js", esModule: embed("/docker/model-transport.mjs") }],
        bindings: [
          { name: "TARGETS", json: json(options.roots.map(root => root + "/chat/completions")) },
          { name: "OS_DASHBOARD_TARGET", text: options.env.OS_DASHBOARD_AI_GATEWAY_ROOT ? options.env.OS_DASHBOARD_AI_GATEWAY_ROOT + "/chat/completions" : "" },
          { name: "MODEL_NETWORK", service: "model-network" },
        ],
      },
    });
  }
  if (active.has("gatekeeper-azure-repos")) {
    services.push({
      name: "azure-network", network: { allow: ["public", "private", "local"], tlsOptions: {
        trustBrowserCas: true, ...(options.azureCas && {trustedCertificates: options.azureCas}),
      } },
    }, {
      name: "azure-transport", worker: {
        compatibilityDate: "2026-09-04",
        modules: [{name: "azure-network.js", esModule: embed("/docker/azure-network.mjs")}],
        bindings: [
          {name: "COLLECTION", text: options.env.AZURE_DEVOPS_COLLECTION_URL},
          {name: "AZURE_UPSTREAM", service: "azure-network"},
        ],
      },
    });
  }
  return services;
}

export function renderConfig(bundles, options) {
  const services = runtimeServices(bundles, options);
  const extensions = [{ modules: ["shared", "zod"].map(name => ({
    name: "miniflare:" + name, esModule: embed("/storage/" + name + ".worker.js"),
  })) }];
  // nginx overwrites this private header on every request. PUBLIC_BASE_URL decides whether to
  // use it, independently of any forwarding headers sent by a browser.
  const http = options.origin.startsWith("https:") ? { forwardedProtoHeader: "X-Workshop-External-Https" } : {};
  const sockets = [{ name: "workshop", address: "*:8787", http, service: "router" }];
  return 'using Workerd = import "/workerd/workerd.capnp";\nconst config :Workerd.Config = ' +
      literal({ services, sockets, extensions }) + ";\n";
}

async function main() {
  const options = deploymentOptions(process.env);
  if (options.vendors.includes("azurerepos") && process.env.AZURE_DEVOPS_CA_FILE) {
    const pem = await readFile(process.env.AZURE_DEVOPS_CA_FILE, "utf8");
    options.azureCas = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!options.azureCas?.length) throw new Error("AZURE_DEVOPS_CA_FILE must contain PEM certificates.");
  }
  const bundles = await Promise.all((await readdir("/app/workers")).map(async name =>
    JSON.parse(await readFile(join("/app/workers", name, "bundle.json"), "utf8"))));
  const config = renderConfig(bundles, options);
  for (const dir of ["objects", "kv", "r2"]) await mkdir(join("/data", dir), { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), "dockerflare-"));
  let exporter, retry;
  function startExporter() {
    exporter = spawn(process.execPath, ["/os-dashboard-export/export.mjs"], { stdio: "inherit" });
    exporter.once("exit", () => {
      if (exporter) retry = setTimeout(startExporter, 5000);
    });
  }
  try {
    const path = join(temp, "config.capnp");
    await writeFile(path, config, { mode: 0o600 });
    const child = spawn("flock", ["--nonblock", "--no-fork", "/data/.workshop.lock",
      "workerd", "serve", "--experimental", "-I/app", path], { stdio: "inherit" });
    if (process.env.OS_DASHBOARD_WORKSHOP_AUDIT_FILE) startExporter();
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 143 : 130)));
    });
    process.exitCode = exitCode;
  } finally {
    clearTimeout(retry);
    exporter?.kill();
    exporter = undefined;
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
