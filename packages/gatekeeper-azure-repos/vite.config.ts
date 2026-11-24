import configurator from "@gadgets/scripts/gatekeeper-configurator";
import { TESTS_WITH_TIMEOUT_ENV, vitestTask, withTestTimeout } from "@gadgets/scripts/vitest-task";

export default {
  ...configurator,
  run: {
    ...configurator.run,
    tasks: {
      ...configurator.run.tasks,
      "build:configurator": {
        ...configurator.run.tasks["build:configurator"],
        command: [configurator.run.tasks["build:configurator"].command, "node build-types.mjs"],
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
