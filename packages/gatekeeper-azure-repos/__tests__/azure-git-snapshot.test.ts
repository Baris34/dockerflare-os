/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fetchSnapshotPack } from "../src/azure-git-snapshot";

it("fetches just the selected snapshot from a classic unfiltered Git server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "azure-snapshot-"));
  const source = join(dir, "source"), target = join(dir, "target");
  mkdirSync(source);
  mkdirSync(target);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {cwd, encoding: "utf8"}).trim();
  try {
    git(source, "init", "-q");
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
    const stream = await fetchSnapshotPack(pin, async body => {
      const bytes = execFileSync("git", ["-c", "uploadpack.allowFilter=false", "upload-pack", "--stateless-rpc", source],
        {input: body, env: {...process.env, GIT_PROTOCOL: "version=0"}});
      return new Response(bytes);
    });
    const pack = Buffer.from(await new Response(stream).arrayBuffer());
    git(target, "init", "--bare", "-q");
    execFileSync("git", ["index-pack", "--stdin"], {cwd: target, input: pack});
    expect(git(target, "show", pin + ":Billing.csproj")).toContain("v4.8");
    expect(execFileSync("git", ["show", pin + ":assets/sample.bin"], {cwd: target})).toEqual(binary);
    const ancestor = execFileSync("git", ["cat-file", "--batch-check"], {cwd: target, input: parent + "\n", encoding: "utf8"});
    expect(ancestor.trim()).toBe(parent + " missing");
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

it("refuses a truncated upload-pack stream and hides remote error text", async () => {
  const pin = "a".repeat(40);
  const truncated = await fetchSnapshotPack(pin, async () => new Response("0034shallow " + pin + "00000008NAK\n0009\u0001PACK"));
  await expect(new Response(truncated).arrayBuffer()).rejects.toThrow("incomplete");
  const failed = await fetchSnapshotPack(pin, async () => new Response("0011ERR sample12\n0000"));
  await expect(new Response(failed).arrayBuffer()).rejects.toThrow("rejected");
});

it("rejects an upstream that sends a pack without confirming the selected shallow boundary", async () => {
  const stream = await fetchSnapshotPack("a".repeat(40), async () =>
    new Response("00000008NAK\n0025\u0001" + "x".repeat(32) + "0000"));
  await expect(new Response(stream).arrayBuffer()).rejects.toThrow("shallow");
});
