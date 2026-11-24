/**
 * Only the model client receives this binding. Docker DNS is resolved at request time, so the
 * Workshop can boot and serve existing workspaces while the inference service is offline.
 */
export default {
  async fetch(request, env) {
    if (request.method !== "POST" || !env.TARGETS.includes(request.url)) {
      return new Response("Unknown inference target", { status: 403 });
    }
    const headers = new Headers();
    for (const name of ["authorization", "content-type", "accept"]) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    const response = await env.MODEL_NETWORK.fetch(new Request(request.url, {
      method: "POST", headers, body: request.body, redirect: "manual", duplex: "half",
      signal: request.signal,
    }));
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response("Inference endpoint redirected the request", { status: 502 });
    }
    return response;
  },
};
