import { CredentialsExpiredError } from "@gadgets/gatekeeper-kit/credentials";
import { readTextCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";

export interface AzureEnv {
  AZURE_DEVOPS_COLLECTION_URL?: string;
  AZURE_DEVOPS_API_VERSION?: string;
  AZURE_NETWORK?: { fetch(request: Request): Promise<Response> };
}

export class AzureAccessDenied extends Error {
  constructor(message = "This Azure Repos resource is unavailable to the connected account.") {
    super(message);
  }
}

type NamedResource = { id: string; name: string };
type Branch = { refName: string; commitId: string };
type Page<T> = { items: T[]; nextCursor?: string };
const pageSize = 100;
const heads = "refs/heads/";
const maxJsonBytes = 8 * 1024 * 1024;
const gitReadPermission = "_apis/permissions/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87/2";

function invalidResponse(): Error {
  return new Error("Invalid Azure DevOps Server response.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

function guid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ||
      value === "00000000-0000-0000-0000-000000000000") throw new Error("Invalid Azure DevOps resource ID.");
  return value.toLowerCase();
}

function oid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value) || /^0+$/.test(value)) {
    throw new Error("Invalid Azure Repos Git object ID.");
  }
  return value.toLowerCase();
}

function branchName(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(heads) || value.length === heads.length) {
    throw new Error("Expected a fully qualified Azure Repos branch name.");
  }
  return value;
}

function namedResource(value: unknown): NamedResource {
  const item = record(value);
  if (typeof item.name !== "string" || !item.name) throw invalidResponse();
  return { id: guid(item.id), name: item.name };
}

function repoPath(projectId: string, repoId: string): string {
  return `${guid(projectId)}/_apis/git/repositories/${guid(repoId)}`;
}

/** Azure's hierarchical Git ACL preserves slash separators and encodes other UTF-16LE code units as hex. */
function branchSecurityToken(projectId: string, repoId: string, refName: string): string {
  const name = branchName(refName).slice(heads.length);
  const encoded = name.replace(/[^/]/g, char => {
    const unit = char.charCodeAt(0);
    return (unit & 255).toString(16).padStart(2, "0") + (unit >> 8).toString(16).padStart(2, "0");
  });
  return `repoV2/${guid(projectId)}/${guid(repoId)}/${heads}${encoded}/`;
}

/** Canonical operator-supplied collection root, including any virtual directory. */
export function collectionUrl(env: AzureEnv): string {
  const value = env.AZURE_DEVOPS_COLLECTION_URL;
  const error = new Error("Configure a plain HTTPS Azure DevOps collection URL.");
  if (!value || value !== value.trim() || /[?#\\\r\n\t]/.test(value)) throw error;
  let url: URL;
  try { url = new URL(value); } catch { throw error; }
  if (url.protocol !== "https:" || url.username || url.password) throw error;
  return url.href.replace(/\/+$/, "");
}

/** Internal, PAT-scoped client. Only fixed REST routes and read-only Git services can carry credentials. */
export class AzureClient {
  readonly #collection: string;
  readonly #version: string;
  readonly #authorization: string;
  readonly #network: AzureEnv["AZURE_NETWORK"];

  constructor(env: AzureEnv, pat: string) {
    this.#collection = collectionUrl(env);
    this.#version = env.AZURE_DEVOPS_API_VERSION || "7.0";
    if (!/^\d+\.\d+(?:-preview(?:\.\d+)?)?$/.test(this.#version)) throw new Error("Invalid Azure DevOps API version.");
    if (!pat || !/^[!-~]+$/.test(pat)) throw new Error("Invalid Azure DevOps personal access token.");
    this.#authorization = "Basic " + btoa(":" + pat);
    this.#network = env.AZURE_NETWORK;
  }

  async #send(path: string, query: Record<string, string>, accept: string, body?: Uint8Array): Promise<Response> {
    const url = new URL(this.#collection + "/" + path);
    url.search = new URLSearchParams(query).toString();
    const headers = new Headers({ Authorization: this.#authorization, Accept: accept, "X-TFS-FedAuthRedirect": "Suppress" });
    if (body !== undefined) headers.set("Content-Type", "application/x-git-upload-pack-request");
    const request = new Request(url, {
      method: body === undefined ? "GET" : "POST",
      headers, body, redirect: "manual", signal: AbortSignal.timeout(60_000),
    });
    let response: Response;
    try {
      response = this.#network ? await this.#network.fetch(request) : await fetch(request);
    } catch {
      // Private connectors and reverse proxies may include request details in their errors.
      throw new Error("Could not contact the configured Azure DevOps Server.");
    }
    if (response.status === 200 && !response.redirected) return response;
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 403 || response.status === 404) throw new AzureAccessDenied();
    if (response.status === 401) throw new CredentialsExpiredError("Azure DevOps rejected the personal access token.");
    throw new Error(`Azure DevOps request failed (HTTP ${response.status}).`);
  }

  async #json(path: string, query: Record<string, string> = {}, version = this.#version) {
    const response = await this.#send(path, { ...query, "api-version": version }, "application/json");
    try {
      const data: unknown = JSON.parse(await readTextCapped(response, maxJsonBytes));
      return { data: record(data), nextCursor: response.headers.get("x-ms-continuationtoken") || undefined };
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw error;
      throw invalidResponse();
    }
  }

  async identity(): Promise<{ collectionId: string; id: string; displayName: string }> {
    // Location.GetConnectionData is still a preview endpoint in Azure DevOps Server 2022.
    const preview = this.#version.split("-")[0] + "-preview.1";
    const { data } = await this.#json("_apis/connectionData", {}, preview);
    const user = record(data.authenticatedUser);
    const id = guid(user.id);
    if (user.isActive === false || id === "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" ||
        (data.authorizedUser && guid(record(data.authorizedUser).id) !== id)) {
      throw new Error("Azure DevOps did not authenticate the PAT as a single user.");
    }
    const displayName = user.customDisplayName || user.providerDisplayName || user.displayName;
    return { collectionId: guid(data.instanceId), id, displayName: typeof displayName === "string" ? displayName : id };
  }

  async #page<T>(path: string, query: Record<string, string>, cursor: string | undefined, parse: (value: unknown) => T): Promise<Page<T>> {
    if (cursor) query.continuationToken = cursor;
    const { data, nextCursor } = await this.#json(path, query);
    if (!Array.isArray(data.value)) throw invalidResponse();
    if (nextCursor && nextCursor === cursor) throw new Error("Azure DevOps returned a repeated continuation token.");
    return { items: data.value.map(parse), nextCursor };
  }

  listProjects(cursor?: string): Promise<Page<NamedResource>> {
    return this.#page("_apis/projects", { $top: String(pageSize) }, cursor, namedResource);
  }

  async getProject(projectId: string): Promise<NamedResource> {
    const { data } = await this.#json("_apis/projects/" + guid(projectId));
    const project = namedResource(data);
    if (project.id !== guid(projectId)) throw invalidResponse();
    return project;
  }

  async listRepositories(projectId: string, cursor?: string): Promise<Page<NamedResource>> {
    // The Server repositories endpoint normally returns the whole project in one response.
    // Retain the upstream token as well as our offset for servers that paginate it.
    let offset = 0;
    let token: string | undefined;
    if (cursor) {
      let parts: unknown;
      try { parts = JSON.parse(cursor); } catch { throw new Error("Invalid Azure Repos page cursor."); }
      if (!Array.isArray(parts) || parts.length !== 2 || (parts[0] !== null && typeof parts[0] !== "string") ||
          !Number.isSafeInteger(parts[1]) || parts[1] < 0) throw new Error("Invalid Azure Repos page cursor.");
      token = parts[0] ?? undefined;
      offset = parts[1];
    }
    const project = guid(projectId);
    const page = await this.#page(project + "/_apis/git/repositories", {}, token, item => {
      if (guid(record(record(item).project).id) !== project) throw invalidResponse();
      return namedResource(item);
    });
    const end = offset + pageSize;
    const next = end < page.items.length ? [token ?? null, end] : page.nextCursor ? [page.nextCursor, 0] : undefined;
    return { items: page.items.slice(offset, end), nextCursor: next && JSON.stringify(next) };
  }

  async getRepository(projectId: string, repoId: string): Promise<NamedResource> {
    const { data } = await this.#json(repoPath(projectId, repoId));
    const repo = namedResource(data);
    if (repo.id !== guid(repoId) || guid(record(data.project).id) !== guid(projectId)) throw new AzureAccessDenied();
    return repo;
  }

  #branches(projectId: string, repoId: string, filter: string, cursor?: string): Promise<Page<Branch>> {
    return this.#page(repoPath(projectId, repoId) + "/refs", { filter, $top: String(pageSize) }, cursor, value => {
      const ref = record(value);
      return { refName: branchName(ref.name), commitId: oid(ref.objectId) };
    });
  }

  listBranches(projectId: string, repoId: string, cursor?: string): Promise<Page<Branch>> {
    return this.#branches(projectId, repoId, "heads/", cursor);
  }

  async getBranch(projectId: string, repoId: string, refName: string): Promise<Branch> {
    const filter = branchName(refName).slice("refs/".length);
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.#branches(projectId, repoId, filter, cursor);
      const ref = page.items.find(item => item.refName === refName);
      if (ref) return ref;
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Azure DevOps repeated a ref page.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    throw new AzureAccessDenied();
  }

  /** Check the calling PAT's live branch permission, pinned revision ancestry, and ability to read the root tree. */
  async verifyPinned(projectId: string, repoId: string, refName: string, commitId: string): Promise<void> {
    const pin = oid(commitId);
    const repo = repoPath(projectId, repoId);
    await this.getRepository(projectId, repoId);
    const { data: acl } = await this.#json(gitReadPermission, {
      tokens: branchSecurityToken(projectId, repoId, refName), alwaysAllowAdministrators: "false",
    });
    if (!Array.isArray(acl.value) || acl.value.length !== 1 || typeof acl.value[0] !== "boolean") throw invalidResponse();
    if (!acl.value[0]) throw new AzureAccessDenied();
    const branch = await this.getBranch(projectId, repoId, refName);
    if (branch.commitId !== pin) {
      const { data } = await this.#json(repo + "/diffs/commits", {
        baseVersion: pin, baseVersionType: "commit", targetVersion: branch.commitId, targetVersionType: "commit", $top: "1",
      });
      if (data.commonCommit === null || oid(data.commonCommit) !== pin) throw new AzureAccessDenied();
    }
    const { data: root } = await this.#json(repo + "/items", {
      path: "/", "versionDescriptor.versionType": "commit", "versionDescriptor.version": pin,
    });
    if (root.path !== "/" || root.gitObjectType !== "tree" || (root.commitId !== undefined && oid(root.commitId) !== pin)) {
      throw invalidResponse();
    }
    oid(root.objectId);
  }

  /** Check Git tree/blob membership by enumerating the selected revision. Submodule commit IDs grant no authority. */
  async hasSnapshotObjects(projectId: string, repoId: string, commitId: string, oids: string[]): Promise<boolean> {
    const pin = oid(commitId);
    const wanted = new Set(oids.map(oid));
    const { data, nextCursor } = await this.#json(repoPath(projectId, repoId) + "/items", {
      scopePath: "/", recursionLevel: "full", "versionDescriptor.versionType": "commit", "versionDescriptor.version": pin,
    });
    if (nextCursor || !Array.isArray(data.value) || data.count !== data.value.length) throw invalidResponse();
    for (const value of data.value) {
      const item = record(value);
      if (item.gitObjectType !== "tree" && item.gitObjectType !== "blob") continue;
      if ((item.path !== "/" || item.commitId !== undefined) && oid(item.commitId) !== pin) throw invalidResponse();
      wanted.delete(oid(item.objectId));
    }
    return wanted.size === 0;
  }

  /** Git v0 discovery and upload-pack RPC for one repository. No protocol-v2 negotiation or write service. */
  async gitUploadPack(projectId: string, repoId: string, body?: Uint8Array): Promise<Response> {
    const base = `${guid(projectId)}/_git/${guid(repoId)}/`;
    const contentType = "application/x-git-upload-pack-" + (body === undefined ? "advertisement" : "result");
    const response = body === undefined
      ? await this.#send(base + "info/refs", { service: "git-upload-pack" }, contentType)
      : await this.#send(base + "git-upload-pack", {}, contentType, body);
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== contentType) {
      await response.body?.cancel().catch(() => undefined);
      throw invalidResponse();
    }
    return response;
  }
}
