import { WorkerEntrypoint } from "cloudflare:workers";
import { AzureUser as User, AzureVerifier as Verifier, GatekeeperVendor as Vendor } from "../../src/azure-repos";
import type { ConnectHandoff, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";

export { default, UserAccount, AzureBranchGatekeeper } from "../../src/azure-repos";
/** The Vitest transform registers undecorated entrypoints for ctx.exports loopback. */
export class GatekeeperVendor extends Vendor {}
export class AzureUser extends User {}
export class AzureVerifier extends Verifier {}

export class TestCallback extends WorkerEntrypoint {
  async complete(user: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> {
    if (!(await user.describe()).uniqueName) throw new Error("Expected an Azure identity.");
    return {targetOrigin: "http://localhost:8787", ticket: "connected"};
  }
  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    return {targetOrigin: "http://localhost:8787", ticket: stageId};
  }
}
