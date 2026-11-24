import configurator from "@gadgets/scripts/gatekeeper-configurator";
import { TESTS_WITH_TIMEOUT_ENV, vitestTask, withTestTimeout } from "@gadgets/scripts/vitest-task";

const frame = configurator.run.tasks["build:configurator"];

export default {
  ...configurator,
  run: {
    ...configurator.run,
    tasks: {
      ...configurator.run.tasks,
      "build:branch-types": {
        command: "node build-types.mjs",
        cache: {
          input: ["src/types.d.ts", "build-types.mjs"],
          output: ["src/generated/branch-types.txt"],
        },
      },
      "build:configurator": {
        ...frame,
        dependsOn: [...frame.dependsOn, "build:branch-types"],
        cache: {
          ...frame.cache,
          input: [...frame.cache.input, { pattern: "src/configurator/**", base: "package" }],
          // Replaying the contract generator must never restore an older picker beside it.
          output: ["src/generated/*-configurator-ui.txt", "src/generated/*.js", "src/generated/*.js.map"],
        },
      },
      "build:integration-worker": {
        command: withTestTimeout("capnweb-validate build --out .wrangler/validate"),
        dependsOn: ["build:configurator"],
        cache: {
          env: TESTS_WITH_TIMEOUT_ENV,
          input: [{ auto: true }, { pattern: "!**/.wrangler/**", base: "workspace" }],
          output: [".wrangler/validate/**"],
        },
      },
      test: {
        ...vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts", "node --test __tests__/contract/checkout.test.mjs"]),
        dependsOn: ["build:configurator"],
      },
    },
  },
};
