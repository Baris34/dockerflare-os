import { DurableObject, RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  resourceTypeUrlPattern, workerVersionTag, type AccountDescription, type ConnectHandoff,
  type Gatekeeper, type GatekeeperConnectCallback, type GatekeeperConnectOptions, type GatekeeperUser,
  type GatekeeperUserVerifier, type GatekeeperVendor as Vendor, type ResourceConfiguratorFrame,
  type SupportedResource, type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  advanceToOAuth, claimOAuth, isConnectAttempted, markConnectAttempted, peekOAuth, putInitiation,
} from "@gadgets/gatekeeper-kit/connect-handshake";
import { CONNECT_TIMEOUT_MS, generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  CONNECT_FORM_NONCE_FIELD, connectFormHtml, connectHandoffPageHtml, errorPageHtml, formPageResponse,
  htmlResponse, INVALID_LINK_HTML, readConnectForm,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, discardStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { clearCredentialExpiryLatch, notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import { isCredentialsExpired } from "@gadgets/gatekeeper-kit/credentials";
import { AzureAccessDenied, AzureClient, collectionUrl, type AzureEnv } from "./azure-client";
import { AzureBranchConfiguratorUI } from "./configurator";
import { BRANCH_URL_PATTERN, openSelection, sealSelection, type BranchSelection } from "./resource-url";
import { type BranchProps, type PinnedBranch } from "./branch";
import TYPES_CODE from "./generated/branch-types.txt";
import CONFIGURATOR_HTML from "./generated/branch-configurator-ui.txt";

export { AzureBranchGatekeeper } from "./branch";

export type Env = Cloudflare.Env & AzureEnv & { BASE_URL?: string };
type AccountProps = { userObjectId: string };
type Credentials = Awaited<ReturnType<AzureClient["identity"]>> & { collection: string; pat: string; generation: string };
type ConnectResult = { handoff: ConnectHandoff } | { retry: string } | { refused: string } | null;

function baseUrl(env: Env): string {
  return (env.BASE_URL ?? "http://localhost:8787/gatekeeper/azure-repos").replace(/\/+$/, "");
}

function resource(): SupportedResource {
  return {
    id: "branch", title: "Azure Repos branch",
    urlPattern: BRANCH_URL_PATTERN,
    description: "Read the selected revision of a Git branch.",
  };
}

function form(env: Env, id: string, nonce: string, error?: string) {
  return formPageResponse(connectFormHtml({
    title: "Connect Azure Repos",
    intro: `Enter a personal access token with Code (Read) and Project and Team (Read) for ${collectionUrl(env)}.`,
    action: `${baseUrl(env)}/${id}/connect`, nonce, error,
    fields: [{ name: "pat", label: "Personal access token", secret: true }],
  }), error ? 400 : 200);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const prefix = new URL(baseUrl(env)).pathname.replace(/\/$/, "") + "/";
    const match = url.pathname.startsWith(prefix)
      && /^([a-f0-9]{64})\/(connect|[a-f0-9]{64})$/.exec(url.pathname.slice(prefix.length));
    if (!match || url.search) return new Response("Not found", { status: 404 });
    const [, id, route] = match;
    let account: DurableObjectStub<UserAccount>;
    try {
      account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(id));
    } catch {
      return htmlResponse(INVALID_LINK_HTML, 400);
    }
    if (route !== "connect") {
      if (req.method !== "GET") return new Response(null, {status: 405, headers: {Allow: "GET"}});
      const nonce = await account.openForm(route);
      return nonce ? form(env, id, nonce) : htmlResponse(INVALID_LINK_HTML, 400);
    }
    const data = await readConnectForm(req, { origin: baseUrl(env) });
    if (data instanceof Response) return data;
    const nonce = data.get(CONNECT_FORM_NONCE_FIELD) ?? "";
    const pat = data.get("pat") ?? "";
    if (!pat || data.getAll("pat").length !== 1 || data.getAll(CONNECT_FORM_NONCE_FIELD).length !== 1) {
      return htmlResponse(errorPageHtml("Connection refused", "Enter a personal access token."), 400);
    }
    try {
      const result = await account.submit(nonce, pat);
      if (!result) return htmlResponse(INVALID_LINK_HTML, 400);
      if ("retry" in result) return form(env, id, nonce, result.retry);
      if ("refused" in result) return htmlResponse(errorPageHtml("Connection refused", result.refused), 403);
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    } catch {
      return htmlResponse(errorPageHtml("Connection failed", "Start a new connection in Workshop."), 502);
    }
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements Vendor {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Azure Repos", url: collectionUrl(this.env), color: "#e7f3fe",
      tagline: "Open a selected Git revision in a Workshop worktree.",
      description: "Connect your Azure DevOps Server account and choose a project, repository and branch.",
    };
  }
  async versionTag(): Promise<string | undefined> { return workerVersionTag(this.env); }
  async getSupportedResources(): Promise<SupportedResource[]> { return [resource()]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{url: string}> {
    const id = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).begin(callback, nonce);
    return {url: `${baseUrl(this.env)}/${id}/${nonce}`};
  }
}

/** This is the only persistent store for a user's PAT. It is reachable only inside the vendor. */
export class UserAccount extends DurableObject<Env> {
  async begin(callback: Fetcher<GatekeeperConnectCallback>, nonce: string) {
    this.ctx.storage.kv.put("callback", callback);
    putInitiation(this.ctx.storage.kv, nonce, Date.now(), {reconnect: false});
    await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
  }
  async beginReconnect(nonce: string) {
    this.credentials();
    putInitiation(this.ctx.storage.kv, nonce, Date.now(), {reconnect: true});
  }
  async openForm(nonce: string): Promise<string | null> {
    return advanceToOAuth(this.ctx.storage.kv, nonce, Date.now());
  }
  async submit(nonce: string, pat: string): Promise<ConnectResult> {
    const kv = this.ctx.storage.kv;
    if (!peekOAuth(kv, nonce, Date.now())) return null;
    const collection = collectionUrl(this.env);
    let identity: Awaited<ReturnType<AzureClient["identity"]>>;
    try {
      identity = await new AzureClient(this.env, pat).identity();
    } catch {
      return peekOAuth(kv, nonce, Date.now()) ? { retry: "Azure could not verify this token." } : null;
    }
    const attempt = claimOAuth<{reconnect: boolean}>(kv, nonce, Date.now());
    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!attempt || !callback) return null;
    const creds: Credentials = { ...identity, collection, pat, generation: generateNonce() };
    if (attempt.reconnect) {
      const live = this.credentials();
      if (creds.id !== live.id || creds.collectionId !== live.collectionId) {
        return {refused: "Start a new reconnect using the same Azure DevOps identity."};
      }
      const stageId = stageCredentials(kv, creds, Date.now());
      try {
        return { handoff: await callback.reconnectComplete(stageId) };
      } catch {
        discardStagedCredentials(kv, stageId);
        throw new Error("Workshop could not confirm this reconnect.");
      }
    }
    if (isConnectAttempted(kv)) return null;
    markConnectAttempted(kv);
    kv.put("credentials", creds);
    clearCredentialExpiryLatch(kv);
    try {
      const user = this.ctx.exports.AzureUser({props: {userObjectId: this.ctx.id.toString()}});
      const handoff = await callback.complete(user);
      await this.ctx.storage.deleteAlarm();
      return {handoff};
    } catch {
      kv.delete("credentials");
      throw new Error("Workshop could not confirm this connection.");
    }
  }
  async commitReconnect(stageId: string): Promise<void> {
    const live = this.credentials();
    const creds = commitStagedCredentials<Credentials>(this.ctx.storage.kv, Date.now(), stageId);
    if (!creds || creds.collectionId !== live.collectionId || creds.id !== live.id || creds.collection !== live.collection) {
      throw new Error("Restart this Azure Repos reconnect.");
    }
    this.ctx.storage.kv.put("credentials", creds);
    clearCredentialExpiryLatch(this.ctx.storage.kv);
  }
  credentials(): Credentials {
    const creds = this.ctx.storage.kv.get<Credentials>("credentials");
    if (!creds || creds.collection !== collectionUrl(this.env)) throw new Error("Reconnect your Azure Repos account.");
    return creds;
  }
  async confirmBranch(projectId: string, repositoryId: string, refName: string, commitId: string):
      Promise<{commitId: string; resourceUrl?: string}> {
    const creds = this.credentials();
    const client = new AzureClient(this.env, creds.pat);
    const tip = await client.getBranch(projectId, repositoryId, refName);
    if (this.credentials().generation !== creds.generation) throw new Error("Azure connection changed. Try again.");
    if (tip.commitId !== commitId) return {commitId: tip.commitId};
    const kv = this.ctx.storage.kv;
    let key = kv.get<Uint8Array<ArrayBuffer>>("selectionKey");
    if (!key) {
      key = crypto.getRandomValues(new Uint8Array(32));
      kv.put("selectionKey", key);
    }
    const selection: BranchSelection = {projectId: projectId.toLowerCase(), repositoryId: repositoryId.toLowerCase(), ...tip};
    return {commitId, resourceUrl: await sealSelection(key, creds, selection)};
  }
  async resolveSelection(url: string): Promise<PinnedBranch> {
    const creds = this.credentials();
    const key = this.ctx.storage.kv.get<Uint8Array<ArrayBuffer>>("selectionKey");
    return {...await openSelection(key, creds, url), collectionId: creds.collectionId};
  }
  /** Verify the account and ref together. A subsequent Git read must use the same PAT we checked. */
  async tokenForPin(pin: PinnedBranch): Promise<string> {
    const creds = this.credentials();
    if (creds.collectionId !== pin.collectionId) throw new AzureAccessDenied();
    const api = new AzureClient(this.env, creds.pat);
    try {
      const identity = await api.identity();
      if (identity.id !== creds.id || identity.collectionId !== pin.collectionId) throw new AzureAccessDenied();
      await api.verifyPinned(pin.projectId, pin.repositoryId, pin.refName, pin.commitId);
    } catch (error) {
      const kv = this.ctx.storage.kv;
      if (isCredentialsExpired(error) && kv.get<Credentials>("credentials")?.generation === creds.generation) {
        await notifyCredentialsExpiredOnce(kv, kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), "azure_repos");
      }
      throw error;
    }
    if (this.credentials().generation !== creds.generation) throw new Error("Azure connection changed. Try again.");
    return creds.pat;
  }
  async verifyPin(pin: PinnedBranch): Promise<void> {
    await this.tokenForPin(pin);
  }
  async hasPin(pin: PinnedBranch): Promise<boolean> {
    try {
      await this.verifyPin(pin);
      return true;
    } catch (error) {
      if (error instanceof AzureAccessDenied) return false;
      throw error;
    }
  }
  async alarm() {
    if (!this.ctx.storage.kv.get("credentials")) await this.ctx.storage.deleteAll();
  }
  async revoke() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}

function userAccount(exports: Cloudflare.Exports, id: string) {
  return exports.UserAccount.get(exports.UserAccount.idFromString(id));
}

@validateRpc()
export class AzureUser extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUser {
  #account() { return userAccount(this.ctx.exports, this.ctx.props.userObjectId); }
  async describe(): Promise<AccountDescription> {
    const {displayName, id, collectionId} = await this.#account().credentials();
    return {displayName, uniqueName: `${collectionId}/${id}`, avatar: {url: ""}};
  }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  async getSupportedResources(): Promise<SupportedResource[]> { return [resource()]; }
  async startResourceConfigurator(resourceTypeId: string): Promise<ResourceConfiguratorFrame> {
    const type = resource();
    if (resourceTypeUrlPattern([type], resourceTypeId) !== type.urlPattern) throw new Error("Unknown Azure resource type.");
    const getClient = async () => new AzureClient(this.env, (await this.#account().credentials()).pat);
    const picker = new AzureBranchConfiguratorUI(getClient,
      (projectId, repositoryId, refName, commitId) => this.#account().confirmBranch(projectId, repositoryId, refName, commitId));
    return {iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(picker)};
  }
  async getGatekeeperClassFor(url: string): Promise<{class: DurableObjectClass<Gatekeeper<any>>; resource: SupportedResource}> {
    const account = this.#account();
    const pin = await account.resolveSelection(url);
    const client = new AzureClient(this.env, await account.tokenForPin(pin));
    const [project, repository] = await Promise.all([
      client.getProject(pin.projectId), client.getRepository(pin.projectId, pin.repositoryId),
    ]);
    const props: BranchProps = {
      ...pin, ...this.ctx.props, project: project.name, repository: repository.name,
    };
    return {class: this.ctx.exports.AzureBranchGatekeeper({props}), resource: resource()};
  }
  async reconnect(): Promise<{url: string}> {
    const nonce = generateNonce();
    await this.#account().beginReconnect(nonce);
    return {url: `${baseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}`};
  }
  async ensureResources(_types: string[]): Promise<{url?: string}> { return {}; }
  async commitReconnect(stageId: string): Promise<void> { await this.#account().commitReconnect(stageId); }
  async revoke(): Promise<void> { await this.#account().revoke(); }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.AzureVerifier({props: this.ctx.props});
  }
}

/** Verifies a prospective collaborator with their own connected Azure account. */
@validateRpc()
export class AzureVerifier extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUserVerifier {
  async hasPin(pin: BranchSelection & {collectionId: string}): Promise<boolean> {
    return await userAccount(this.ctx.exports, this.ctx.props.userObjectId).hasPin(pin);
  }
}
