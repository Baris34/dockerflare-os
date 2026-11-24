import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";
import { fakeAzure } from "./__tests__/workerd/fake-azure.ts";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate: deployed.worker.compatibilityDate,
        compatibilityFlags: deployed.worker.compatibilityFlags,
        modulesRules: [{type: "Text", include: ["**/*.txt"]}],
        durableObjects: {
          USER_ACCOUNT: {className: "UserAccount", useSQLite: true},
          BRANCH: {className: "AzureBranchGatekeeper", useSQLite: true},
        },
        bindings: {
          BASE_URL: "http://localhost:8787/gatekeeper/azure-repos",
          AZURE_DEVOPS_COLLECTION_URL: "https://ado.test/tfs/DefaultCollection",
        },
        serviceBindings: { AZURE_NETWORK: fakeAzure },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
