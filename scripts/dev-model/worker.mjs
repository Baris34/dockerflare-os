import transport from "../../docker/model-transport.mjs";

/** Use Wrangler's local outbound fetch with the same request policy as Docker. */
export default {
  fetch(request, env) {
    return transport.fetch(request, { TARGETS: env.TARGETS, MODEL_NETWORK: { fetch: req => fetch(req) } });
  },
};
