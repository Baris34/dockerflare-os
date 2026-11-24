/// <reference types="@cloudflare/vitest-plugin/types" />
import type { UserAccount } from "../src/azure-repos";
declare global {
  namespace Cloudflare {
    interface Env { USER_ACCOUNT: DurableObjectNamespace<UserAccount>; }
  }
}
