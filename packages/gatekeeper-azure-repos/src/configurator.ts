import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AzureClient } from "./azure-client";
import type { BranchConfiguratorRpc } from "./configurator/branch-configurator-types";

/** Human-only discovery through the account's current credential on each request. */
@validateRpc()
export class AzureBranchConfiguratorUI extends RpcTarget implements BranchConfiguratorRpc {
  #getClient: () => Promise<AzureClient>;
  #confirm: BranchConfiguratorRpc["confirmBranch"];

  constructor(getClient: () => Promise<AzureClient>, confirm: BranchConfiguratorRpc["confirmBranch"]) {
    super();
    this.#getClient = getClient;
    this.#confirm = confirm;
  }

  async listProjects(cursor: string | null) {
    return (await this.#getClient()).listProjects(cursor ?? undefined);
  }

  async repositoryCatalog(projectId: string) {
    return (await this.#getClient()).repositoryCatalog(projectId);
  }

  async listRepositories(projectId: string, cursor: string | null) {
    return (await this.#getClient()).listRepositories(projectId, cursor ?? undefined);
  }

  async listBranches(projectId: string, repositoryId: string, cursor: string | null) {
    return (await this.#getClient()).listBranches(projectId, repositoryId, cursor ?? undefined);
  }

  async confirmBranch(projectId: string, repositoryId: string, refName: string, commitId: string) {
    return this.#confirm(projectId, repositoryId, refName, commitId);
  }
}
