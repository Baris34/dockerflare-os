/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fetchSnapshotPack } from "../src/azure-git-snapshot";

const oid = "a".repeat(40);
const pkt = (line: string) => (Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line;
const banner = pkt("# service=git-upload-pack\n") + "0000";
const advertised = (capabilities: string, tip = oid) =>
  banner + pkt(tip + " HEAD\0" + capabilities + "\n") + "0000";
const boundary = pkt("shallow " + oid) + "0000";

it("fetches just the selected snapshot from a classic unfiltered Git server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "azure-snapshot-"));
  const source = join(dir, "source"), target = join(dir, "target");
  mkdirSync(source);
  mkdirSync(target);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {cwd, encoding: "utf8"}).trim();
  try {
    git(source, "init", "-q", "--object-format=sha1");
    const commit = () => git(source, "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
      "-c", "commit.gpgSign=false", "commit", "-qm", "fixture");
    writeFileSync(join(source, "Billing.csproj"), "previous");
    git(source, "add", ".");
    commit();
    const parent = git(source, "rev-parse", "HEAD");
    writeFileSync(join(source, "Billing.csproj"), "<TargetFrameworkVersion>v4.8</TargetFrameworkVersion>");
    mkdirSync(join(source, "assets"));
    const binary = Buffer.from([0, 13, 10, 255, 128]);
    writeFileSync(join(source, "assets", "sample.bin"), binary);
    git(source, "add", ".");
    commit();
    const pin = git(source, "rev-parse", "HEAD");
    writeFileSync(join(source, "Billing.csproj"), "advanced");
    git(source, "add", ".");
    commit();
    const tip = git(source, "rev-parse", "HEAD");
    let discovered = false;
    let depthRequest: Buffer | undefined;
    const stream = await fetchSnapshotPack(pin, async body => {
      const args = ["-c", "uploadpack.allowReachableSHA1InWant=true", "upload-pack", "--stateless-rpc"];
      const env = {...process.env, GIT_PROTOCOL: "version=0"};
      if (body === undefined) {
        discovered = true;
        const refs = execFileSync("git", [...args, "--advertise-refs", source], {env});
        return new Response(Buffer.concat([Buffer.from(banner), refs]));
      }
      // This server requires the same two stateless requests as native git clone --depth=1.
      const input = Buffer.from(body);
      if (!discovered || !input.toString().includes("want " + pin + " ") ||
          !input.toString().includes("000cdeepen 10000")) return new Response(null, {status: 400});
      if (input.toString().endsWith("0009done\n")) {
        if (!depthRequest?.equals(input.subarray(0, -9))) return new Response(null, {status: 400});
      } else {
        depthRequest = input;
      }
      const bytes = execFileSync("git", [...args, source], {input, env});
      return new Response(bytes);
    });
    const pack = Buffer.from(await new Response(stream).arrayBuffer());
    git(target, "init", "--bare", "-q", "--object-format=sha1");
    execFileSync("git", ["index-pack", "--stdin"], {cwd: target, input: pack});
    expect(git(target, "show", pin + ":Billing.csproj")).toContain("v4.8");
    expect(execFileSync("git", ["show", pin + ":assets/sample.bin"], {cwd: target})).toEqual(binary);
    const missing = execFileSync("git", ["cat-file", "--batch-check"], {cwd: target, input: parent + "\n" + tip + "\n", encoding: "utf8"});
    expect(missing.trim().split(/\r?\n/)).toEqual([parent + " missing", tip + " missing"]);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

it("uses the advertised side-band variant and omits unsupported capabilities", async () => {
  const refs = banner + pkt("b".repeat(40) + " HEAD\0side-band shallow\n") +
    pkt(oid + " refs/heads/release\n") + "0000";
  const result = boundary + pkt("NAK\n") + pkt("\u0002progress") + pkt("\u0001" + "x".repeat(32)) + "0000";
  const stream = await fetchSnapshotPack(oid, async body => {
    if (!body) return new Response(refs);
    const text = Buffer.from(body).toString();
    if (!text.includes(pkt("want " + oid + " side-band\n"))) return new Response(null, {status: 400});
    return new Response(text.endsWith("0000") ? boundary : result);
  });
  expect(await new Response(stream).text()).toBe("x".repeat(32));
});

it.each([
  [advertised("side-band-64k"), "shallow"],
  [advertised("shallow"), "side-band"],
  [advertised("shallow side-band-64k", "b".repeat(40)), "selected revision"],
  [advertised("shallow side-band-64k object-format=sha256"), "object format"],
  ["oops", "advertisement"],
])("refuses an incompatible advertisement before fetching objects", async (refs, expected) => {
  const fetch = async (body?: Uint8Array) => {
    if (body) throw new Error("unexpected POST");
    return new Response(refs);
  };
  await expect(fetchSnapshotPack(oid, fetch)).rejects.toThrow(expected);
});

it("keeps the original pin when a tip-only server rejects it after a branch advance", async () => {
  const tip = "b".repeat(40);
  const requests: string[] = [];
  const fetch = async (body?: Uint8Array) => {
    if (body === undefined) return new Response(advertised("shallow side-band allow-tip-sha1-in-want", tip));
    requests.push(Buffer.from(body).toString());
    return new Response(pkt("ERR upload-pack: not our ref " + oid) + "0000");
  };
  await expect(fetchSnapshotPack(oid, fetch)).rejects.toThrow("did not confirm the selected shallow revision");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("want " + oid + " ");
  expect(requests[0]).not.toContain(tip);
});

it.each([
  [boundary, boundary + "0008NAK\n0009\u0001PACK", "incomplete"],
  [boundary, pkt("ERR sample12\n") + "0000", "shallow"],
  [boundary, "00000008NAK\n" + pkt("\u0001" + "x".repeat(32)) + "0000", "shallow"],
  ["0000", "unused", "shallow"],
])("refuses incomplete or unconfirmed snapshots in either round", async (depthReply, packReply, expected) => {
  const read = async () => {
    const stream = await fetchSnapshotPack(oid, async body => {
      if (body === undefined) return new Response(advertised("shallow side-band-64k no-progress"));
      return new Response(Buffer.from(body).toString().endsWith("0000") ? depthReply : packReply);
    });
    return await new Response(stream).arrayBuffer();
  };
  await expect(read()).rejects.toThrow(expected);
});
