import { configuredModelApiRoots } from "../../packages/workshop-shared/src/model-api-root.ts";

/** Build the private model worker's Wrangler settings only when the operator supplies roots. */
export function devModelWorkerConfig(setting: string | undefined) {
  const roots = configuredModelApiRoots(setting);
  if (roots.length === 0) return undefined;
  return {
    roots,
    name: "dev-model-transport",
    main: "worker.mjs",
    vars: { TARGETS: roots.map(root => root + "/chat/completions") },
  };
}
