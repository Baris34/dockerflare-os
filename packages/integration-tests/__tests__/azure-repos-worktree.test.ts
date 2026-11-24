import { execFileSync } from "node:child_process";
import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { BranchConfiguratorRpc } from "../../gatekeeper-azure-repos/src/configurator/branch-configurator-types";
import { loadAllChatHistory } from "../src/agent-session.js";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder,
  signUp, stubFor, waitFor, waitForIdleChat,
} from "../src/rpc-client.js";

const worker = "gatekeeper-azure-repos";
const vendor = "azure_repos";
const baseUrl = "https://workshop.test/gatekeeper/azure-repos";
const collection = "https://azure.example.test/tfs/Engineering";
const project = "172cf866-bbf3-4063-a89a-55e18d0a55f1";
const repo = "d996ae88-74d5-4426-99d9-048ceecaf6b5";
const refName = "refs/heads/release/legacy";
const pat = "workshop-test-fixture-pat";
const observerPat = "workshop-observer-fixture-pat";
const models = scriptedModelRouter();
const projectXml = (target: string) =>
  `<Project><PropertyGroup><TargetFrameworkVersion>${target}</TargetFrameworkVersion></PropertyGroup></Project>\n`;

// Only the Azure REST API is synthetic. Native Git supplies every OID, object and protocol
// response, so the worktree assertion exercises the real gatekeeper -> kernel pack transfer.
function createFixture() {
  const directory = mkdtempDisposableSync(join(tmpdir(), "workshop-azure-repos-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", directory.path, ...args], { encoding: "utf8" }).trim();
  const write = (name: string, content: string) => writeFileSync(join(directory.path, name), content);
  const commit = () => {
    git("add", "-A");
    git("-c", "user.name=Workshop Test", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "--initial-branch=main", "--object-format=sha1");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", join(directory.path, "no-hooks"));
  write("Legacy.csproj", projectXml("v4.7.2"));
  const main = commit();
  git("switch", "--quiet", "-c", refName.slice("refs/heads/".length));
  const names = ["Legacy", "Sdk", "Imported", "Conditional"];
  const sln = ["Microsoft Visual Studio Solution File, Format Version 12.00",
    ...names.flatMap((name, i) => [
      `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${name}", "${name}.csproj", "{DA567D15-6C82-459F-AC50-00000000000${i}}"`,
      "EndProject",
    ]), "Global", "EndGlobal", ""].join("\n");
  write("Pilot.sln", sln);
  write("Legacy.csproj", projectXml("v4.8"));
  write("Sdk.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>');
  write("Imported.csproj", '<Project><Import Project="Framework.props" /></Project>');
  write("Framework.props", projectXml("v4.8"));
  write("Conditional.csproj", '<Project><PropertyGroup Condition="Exists(\'$(CustomSdk)\')"><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup></Project>');
  const pin = commit();
  let tip = pin;
  const root = { path: "/", gitObjectType: "tree", commitId: pin, objectId: git("rev-parse", pin + "^{tree}") };
  const requests: string[] = [];
  let observerAllowed = false;
  const handler: Handler = async (url, method, headers, request) => {
    if (!url.href.startsWith(collection + "/")) return null;
    const path = url.pathname.slice(new URL(collection).pathname.length);
    requests.push(method + " " + path);
    const otherUser = headers.get("authorization") === "Basic " + btoa(":" + observerPat);
    if (!otherUser && headers.get("authorization") !== "Basic " + btoa(":" + pat)) return new Response(null, { status: 401 });
    const api = `/${project}/_apis/git/repositories/${repo}`;
    if (method === "GET") {
      if (path === "/_apis/connectionData") return Response.json({
        instanceId: "a661f395-b5ec-4d32-a3bf-1eaa686258d0",
        authenticatedUser: { id: otherUser ? "8ddfa051-2784-499c-9fa5-99ef2e56825a" : "7dc20d34-dce8-41f3-8f5e-130f70276a3c",
          providerDisplayName: otherUser ? "Workshop Collaborator" : "Workshop Developer" },
      });
      const team = { id: project, name: "Engineering" };
      const pilot = { id: repo, name: "Pilot", project: team };
      if (path === "/_apis/projects") return Response.json({ value: [team] });
      if (path === "/_apis/projects/" + project) return Response.json(team);
      if (path === `/${project}/_apis/git/repositories`) return Response.json({ value: [
        { id: "e87ba9b0-f39f-44b4-ba93-2dfb93be57b7", name: "Other", project: team }, pilot,
      ] });
      if (path === api) return Response.json(pilot);
      if (path === "/_apis/permissions/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87/2") {
        return Response.json({ value: [!otherUser || observerAllowed] });
      }
      if (path === api + "/refs") {
        const refs = [{ name: "refs/heads/main", objectId: main }, { name: refName, objectId: tip }];
        return Response.json({ value: refs.filter(ref => ref.name.slice(5).startsWith(url.searchParams.get("filter") ?? "")) });
      }
      if (path === api + "/diffs/commits" && url.searchParams.get("baseVersion") === pin &&
          url.searchParams.get("targetVersion") === tip) return Response.json({ commonCommit: git("merge-base", pin, tip) });
      if (path === api + "/items" && url.searchParams.get("versionDescriptor.versionType") === "commit" &&
          url.searchParams.get("versionDescriptor.version") === pin) {
        if (url.searchParams.get("path") === "/") return Response.json(root);
        if (url.searchParams.get("scopePath") === "/" && url.searchParams.get("recursionLevel") === "full") {
          const files = git("ls-tree", "-r", "--name-only", pin).split("\n");
          const items = [root, ...files.map(name => ({
            path: "/" + name, gitObjectType: "blob", commitId: pin, objectId: git("rev-parse", pin + ":" + name),
          }))];
          return Response.json({ count: items.length, value: items });
        }
      }
    }
    if (path === `/${project}/_git/${repo}/git-upload-pack` && method === "POST") {
      const output = execFileSync("git", ["-c", "uploadpack.allowFilter=false", "upload-pack", "--stateless-rpc", directory.path],
        { input: Buffer.from(await request.arrayBuffer()), env: { ...process.env, GIT_PROTOCOL: "version=0" } });
      return new Response(output, { headers: { "content-type": "application/x-git-upload-pack-result" } });
    }
    return null;
  };
  return { pin, requests, handler, directory,
    grantObserverRead() { observerAllowed = true; },
    advance() { write("Legacy.csproj", projectXml("v4.8.1")); tip = commit(); },
    refs() { return git("show-ref"); },
  };
}

let fixture: ReturnType<typeof createFixture>;
let harness: Harness;
const network = new NetworkInterceptor({ handlers: [models.handler, (...args) => fixture.handler(...args)] });
beforeAll(async () => {
  fixture = createFixture();
  network.install();
  harness = await startHarness({ enableGadgetExecution: true, gatekeepers: [{
    binding: "AZURE_REPOS", dir: fileURLToPath(new URL("../../gatekeeper-azure-repos/", import.meta.url).href),
    patch(config) {
      delete config.build;
      config.vars = { ...config.vars, BASE_URL: baseUrl, AZURE_DEVOPS_COLLECTION_URL: collection };
    },
  }] });
});
afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
    fixture?.directory.remove();
  }
});

async function connectAzure(api: RpcStub<AuthenticatedApi>, personalToken: string) {
  const begun = await api.connectAccount(vendor);
  const page = await harness.fetchWorker(worker, begun.url);
  expect(page.status).toBe(200);
  const form = await page.text();
  const action = /<form[^>]* action="([^"]+)"/.exec(form)?.[1];
  const nonce = /name="nonce" value="([^"]+)"/.exec(form)?.[1];
  if (!action || !nonce) throw new Error("The Azure connect form is missing its action or nonce.");
  const submitted = await harness.fetchWorker(worker, action, {method: "POST",
    headers: { origin: new URL(baseUrl).origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({nonce, pat: personalToken}).toString(),
  });
  expect(submitted.status).toBe(200);
  const ticket = /var ticket = (".*?");\n/.exec(await submitted.text());
  if (!ticket) throw new Error("Azure connect did not return a handoff ticket.");
  await api.completeConnectHandoff(JSON.parse(ticket[1]!), begun.nonce);
  return await waitFor("the Azure account", async () =>
    (await listConnectedAccounts(api)).find(candidate => candidate.vendorId === vendor) ?? null);
}

it("opens the chosen Azure revision and reads its .NET Framework evidence in a Workshop chat", async () => {
  const [username, collaborator] = nextUsernames("azurerepos", "azureviewer");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  const account = await connectAzure(api, pat);
  const frame = await api.startResourceConfigurator(account.id, "branch");
  using picker = frame.ui as unknown as RpcStub<BranchConfiguratorRpc>;
  expect((await picker.listProjects(null)).items).toContainEqual({ id: project, name: "Engineering" });
  expect((await picker.listRepositories(project, null)).items.map(item => item.name)).toEqual(["Other", "Pilot"]);
  const branches = (await picker.listBranches(project, repo, null)).items;
  const selected = branches.find(branch => branch.refName === refName);
  if (!selected || selected.commitId !== fixture.pin) throw new Error("Expected the pilot release branch.");
  const { resourceUrl } = await picker.confirmBranch(project, repo, selected.refName, selected.commitId);
  if (!resourceUrl) throw new Error("The Azure picker did not confirm the selected revision.");
  using ws = await api.newWorkspace();
  using connection = await ws.newGatekeeper(account.id, resourceUrl);
  if (!connection) throw new Error("Workshop did not attach the selected branch.");
  const creation = JSON.stringify(await connection.getCreationSpec());
  for (const privateField of [refName, fixture.pin, project, repo, "Engineering"]) {
    expect(creation).not.toContain(privateField);
  }
  using reader = await ws.createGadget("Reader", undefined, "READER");
  await reader.bind("AZURE_REPOS", await connection.getId());
  fixture.advance();
  const initialRefs = fixture.refs();

  const answer = "Pilot.sln includes Legacy.csproj (v4.8), Sdk.csproj (net48), and Imported.csproj via Framework.props (v4.8). Conditional.csproj depends on CustomSdk.";
  const model = models.script([
    { toolCall: { id: "checkout", name: "executeCode", arguments: {
      code: "export default async function(self, env) { return await env.AZURE_REPOS.getCheckout(); }",
    }}},
    { toolCall: { id: "worktree", name: "createWorktree", arguments: {
      bindingName: "SOURCE", title: "Azure revision", commitId: fixture.pin,
    }}},
    { toolCall: { id: "inspect", name: "executeCode", arguments: {
      code: `export default async function(self, env) {
        const entries = await env.SOURCE.listFiles("", {recursive: true});
        for (const {path} of entries) {
          if (/\\.(sln|csproj|props)$/.test(path)) console.log(path, await env.SOURCE.readFile(path));
        }
      }`,
    }}},
    { text: answer },
  ]);
  await api.addModel(model.userModel.profile, model.userModel.config);
  const chat = await ws.newChat("Inspect the solution at the selected Azure revision. Which projects target .NET Framework 4.8?", SCRIPTED_MODEL_ID);
  await waitFor("the final model request", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chat);
  const toolResult = (index: number, id: string, expected: string) =>
    expect(model.requests[index]).toMatchObject({messages: expect.arrayContaining([
      expect.objectContaining({role: "tool", tool_call_id: id, content: expect.stringContaining(expected)}),
    ])});
  toolResult(1, "checkout", fixture.pin);
  toolResult(1, "checkout", refName);
  for (const evidence of ["Pilot.sln", "Legacy.csproj", "<TargetFrameworkVersion>v4.8</", "Sdk.csproj", "<TargetFramework>net48</",
    "Imported.csproj", '<Import Project="Framework.props"', "Conditional.csproj", "$(CustomSdk)"]) {
    toolResult(3, "inspect", evidence);
  }
  expect(JSON.stringify(model.requests)).not.toContain("v4.8.1");
  expect(JSON.stringify(model.requests)).not.toContain(pat);
  expect(fixture.requests).toContain(`POST /${project}/_git/${repo}/git-upload-pack`);
  expect(fixture.requests.every(request => request.startsWith("GET ") || request === `POST /${project}/_git/${repo}/git-upload-pack`)).toBe(true);
  expect(fixture.refs()).toBe(initialRefs);
  const history = await loadAllChatHistory(before => ws.getChatHistory(chat, before));
  expect(history).toContainEqual(expect.objectContaining({type: "message", message: answer}));

  using observer = await signUp(publicApi, collaborator!);
  const observerAccount = await connectAzure(observer, observerPat);
  const workspaceId = (await ws.getMetadata()).id;
  await ws.addCollaborator(collaborator!, "workspace");
  const recorder = new ObserverConfigRecorder().alwaysChoose(observerAccount.id, MAX_OBSERVER_PROMPTS);
  using callback = stubFor(recorder);
  await expect(observer.openWorkspace(workspaceId, undefined, callback)).rejects.toThrow("can't access");
  const prompt = JSON.stringify(recorder.needAt(0));
  for (const privateField of [refName, fixture.pin, project, repo, "Engineering"]) {
    expect(prompt).not.toContain(privateField);
  }
  fixture.grantObserverRead();
  using retry = stubFor(new ObserverConfigRecorder().alwaysChoose(observerAccount.id, 1));
  using allowed = await observer.openWorkspace(workspaceId, undefined, retry);
  expect((await allowed.getMetadata()).id).toBe(workspaceId);
});
