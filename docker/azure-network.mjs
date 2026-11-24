const guid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const collectionRead = new RegExp(`^/_apis/(?:connectionData|projects(?:/${guid})?|permissions/${guid}/2)/?$`, "i");
const repositoryRead = new RegExp(`^/${guid}/_apis/git/repositories(?:/${guid}(?:/(?:refs|items|commits(?:/[0-9a-f]{40})?|diffs/commits|trees/[0-9a-f]{40}))?)?/?$`, "i");
const gitPath = /^\/([^/]+)\/_git\/([^/]+)\/(info\/refs|git-upload-pack)$/;

function validGitSegment(segment) {
  try {
    const name = decodeURIComponent(segment);
    return name !== "." && name !== ".." && !name.startsWith("_") && !/[\\/?#\p{Cc}]|%[\da-f]{2}/iu.test(name);
  } catch { return false; }
}

/** Only the Azure worker receives this service; the operator controls the upstream collection. */
export default {
  async fetch(request, env) {
    const target = new URL(request.url);
    const collection = new URL(env.COLLECTION);
    const base = collection.pathname.replace(/\/+$/, "");
    const path = target.pathname.slice(base.length);
    if (collection.protocol !== "https:" || collection.origin !== target.origin ||
        !target.pathname.startsWith(base + "/") || target.username || target.password) {
      return new Response("Unknown Azure collection", {status: 403});
    }
    const match = gitPath.exec(path);
    const git = match && validGitSegment(match[1]) && validGitSegment(match[2]) && match[3];
    const read = request.method === "GET" &&
      (collectionRead.test(path) || repositoryRead.test(path) ||
        (git === "info/refs" && target.search === "?service=git-upload-pack"));
    const uploadPack = request.method === "POST" && git === "git-upload-pack" && !target.search;
    if (!read && !uploadPack) return new Response("Unsupported Azure operation", {status: 403});
    const headers = new Headers();
    for (const name of ["Authorization", "Content-Type", "Accept", "X-TFS-FedAuthRedirect"]) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    const outgoing = new Request(target, {
      method: request.method, headers, redirect: "manual", signal: request.signal,
      ...(uploadPack && {body: request.body, duplex: "half"}),
    });
    // Local Wrangler uses its own outbound network. In Docker the network is a private binding.
    const response = await (env.AZURE_UPSTREAM ?? globalThis).fetch(outgoing);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response("Azure DevOps redirected the request", {status: 502});
    }
    return response;
  },
};
