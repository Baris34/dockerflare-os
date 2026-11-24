/** Compare Workshop's checkout with a read-only request to the operator's Azure collection. */
export async function verifyCheckout(settings, fetcher = fetch) {
  const { project, repository, branch, path, version } = settings;
  const collection = new URL(settings.collection);
  if (collection.protocol !== "https:" || collection.username || collection.password ||
      /[?#\\]/.test(settings.collection)) {
    throw new Error("Use a plain HTTPS collection URL.");
  }
  if (!path.startsWith("/") || !path.toLowerCase().endsWith(".csproj")) {
    throw new Error("Choose a repository-relative .csproj path starting with /.");
  }
  const root = collection.href.replace(/\/+$/, "") + "/";
  const headers = {Authorization: "Basic " + btoa(":" + settings.pat), Accept: "application/json"};
  async function read(route, label, query = {}) {
    const url = new URL(root + route);
    url.search = new URLSearchParams({...query, "api-version": version}).toString();
    const response = await fetcher(url, {headers, redirect: "error", signal: AbortSignal.timeout(30_000)});
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Azure DevOps ${label} returned HTTP ${response.status}.`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Azure DevOps ${label} did not return JSON.`);
    }
    return {data, next: response.headers.get("x-ms-continuationtoken")};
  }
  async function find(route, label, name, query = {}) {
    const seen = new Set();
    let token;
    do {
      const {data, next} = await read(route, label, token ? {...query, continuationToken: token} : query);
      if (!Array.isArray(data?.value)) throw new Error(`Invalid Azure DevOps ${label} page.`);
      const entry = data.value.find(item => item?.name === name);
      if (entry) return entry;
      if (next && seen.has(next)) throw new Error(`Azure DevOps ${label} repeated continuation token.`);
      seen.add(next);
      token = next;
    } while (token);
    throw new Error(`Selection not found in Azure DevOps ${label}.`);
  }
  const id = value => {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
      throw new Error("Azure DevOps returned an invalid resource ID.");
    }
    return value;
  };
  const team = await find("_apis/projects", "projects", project);
  const repositories = id(team.id) + "/_apis/git/repositories";
  const repo = await find(repositories, "repositories", repository);
  const prefix = repositories + "/" + id(repo.id);
  const ref = await find(prefix + "/refs", "refs", "refs/heads/" + branch, {filter: "heads/" + branch});
  if (!/^[0-9a-f]{40}$/.test(ref.objectId)) throw new Error("Invalid Azure DevOps branch head.");
  const {data} = await read(prefix + "/items", "items", {
    path, "versionDescriptor.versionType": "commit", "versionDescriptor.version": ref.objectId, includeContent: "true",
  });
  if (data.path !== path || data.gitObjectType !== "blob" || data.commitId !== ref.objectId ||
      typeof data.content !== "string" || !/<Project(?:\s|>)/i.test(data.content)) {
    throw new Error("Azure DevOps did not return the expected project file at the selected commit.");
  }
  return {commitId: ref.objectId, path};
}
