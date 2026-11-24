// Runs in the Linux image builder. Wrangler is used only to create its deployment modules.
import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, globSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { collectModules } from "../scripts/release/hash-lib.ts";
import {
  buildWorkerEntry, readDeployablePackages, readDeployInputs,
} from "../scripts/release/manifest-lib.ts";
import { vpRunEnv } from "../scripts/vp/concurrency.ts";

const [outputDirectory, group] = process.argv.slice(2);
if (!outputDirectory || !["core", "optional"].includes(group)) {
  throw new Error("Usage: node docker/build-workers.mjs OUTPUT_DIRECTORY core|optional");
}
const out = resolve(outputDirectory);
const packages = readDeployablePackages(resolve("packages"));
const core = new Set(["router", "workshop-backend", "gatekeeper-context", "gatekeeper-scheduler"]);
// Email Routing and Workers AI search need Cloudflare-managed services.
const unavailable = new Set(["gatekeeper-email", "gatekeeper-websearch"]);

function runPnpm(args, cwd = process.cwd()) {
  execFileSync("pnpm", args, { cwd, stdio: "inherit", env: process.env });
}

function runTask(...args) {
  // BuildKit already caches these stages, including their generated outputs.
  execFileSync("pnpm", ["exec", "vp", "run", "--no-cache", ...args], { stdio: "inherit", env: vpRunEnv() });
}

function restoreTypeLinks() {
  // With core.symlinks=false Git checks out these links as small text files. Preserve the .txt
  // paths that Wrangler's module rules use while exposing the actual declarations inside them.
  for (const pkg of packages) {
    for (const file of globSync("src/**/*.txt", { cwd: pkg.dir })) {
      const path = join(pkg.dir, file);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 255) continue;
      const target = readFileSync(path, "utf8").trim();
      if (!/^[\w.-]+\.d\.ts$/.test(target) || !existsSync(join(dirname(path), target))) continue;
      unlinkSync(path);
      symlinkSync(target, path);
    }
  }
}

function packageRuntime() {
  const fromBackend = createRequire(resolve("packages/workshop-backend/package.json"));
  const fromMiniflare = createRequire(fromBackend.resolve("miniflare/package.json"));
  const fromWorkerd = createRequire(fromMiniflare.resolve("workerd/package.json"));
  for (const [arch, suffix] of [["amd64", "64"], ["arm64", "arm64"]]) {
    const native = fromWorkerd.resolve(`@cloudflare/workerd-linux-${suffix}/bin/workerd`);
    const dir = join(out, "native", arch);
    mkdirSync(dir, { recursive: true });
    copyFileSync(native, join(dir, "workerd"));
    chmodSync(join(dir, "workerd"), 0o755);
  }
  mkdirSync(join(out, "storage"), { recursive: true });
  copyFileSync(fromMiniflare.resolve("workerd/workerd.capnp"), join(out, "storage", "workerd.capnp"));

  // Keep the plugins and their extension modules in lockstep with their native binding protocol.
  for (const [name, source] of Object.entries({
    kv: "kv/namespace",
    r2: "r2/bucket",
    "object-entry": "shared/object-entry",
    shared: "shared/index",
    zod: "shared/zod",
  })) {
    const script = fromBackend.resolve(`miniflare/dist/src/workers/${source}.worker.js`);
    copyFileSync(script, join(out, "storage", `${name}.worker.js`));
  }
}

function bundle(pkg) {
  const scratch = mkdtempSync(join(tmpdir(), "workshop-bundle-"));
  const args = ["exec", "wrangler", "deploy", "--dry-run", "--outdir", scratch];
  // nginx owns the frontend assets. Use a sibling config so Wrangler resolves the original
  // relative entrypoint and source paths even when the web image hasn't been built.
  const configPath = join(pkg.dir, "wrangler.self-host.json");
  try {
    if (pkg.config.assets) {
      const { assets, ...workerConfig } = pkg.config;
      writeFileSync(configPath, JSON.stringify(workerConfig));
      args.push("--config", configPath);
    }
    runPnpm(args, pkg.dir);
    const { modules, mainModule } = collectModules(scratch);
    const entry = buildWorkerEntry({
      pkgName: pkg.name, config: pkg.config, mainModule, modules, deployInputs: readDeployInputs(pkg.dir),
    });
    const dir = join(out, "workers", pkg.name);
    mkdirSync(dir, { recursive: true });
    for (const { name, bytes } of modules) {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    const manifest = {
      config: pkg.config, mainModule, modules: modules.map(({ name, type }) => ({ name, type })),
      ...(entry.shortName && { shortName: entry.shortName, inputs: entry.inputs }),
    };
    writeFileSync(join(dir, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n");
  } finally {
    if (pkg.config.assets) rmSync(configPath, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (group === "core") {
  restoreTypeLinks();
  packageRuntime();
  runTask("-F", "@gadgets/typed-storage", "build");
  runTask("-F", "@gadgets/workshop-backend", "build:bundled-blueprints");
  runTask("-r", "build:app");
} else {
  runTask("-r", "build:configurator");
}
for (const pkg of packages) {
  if (!unavailable.has(pkg.name) && core.has(pkg.name) === (group === "core")) bundle(pkg);
}
