import type { AzureClient } from "../azure-client";

/** The fields chosen in this frame. Names are for display; only GUIDs travel back to Azure. */
export type BranchConfiguratorValues = {
  projectId?: string | null;
  projectName?: string | null;
  repositoryId?: string | null;
  repositoryName?: string | null;
  refName?: string | null;
  commitId?: string | null;
};

/** The signed-in user's discovery capability, available only to the resource configurator. */
export interface BranchConfiguratorRpc {
  listProjects(cursor: string | null): ReturnType<AzureClient["listProjects"]>;
  /** Names and IDs that this account can search within the selected project. */
  repositoryCatalog(projectId: string): ReturnType<AzureClient["repositoryCatalog"]>;
  listRepositories(projectId: string, cursor: string | null): ReturnType<AzureClient["listRepositories"]>;
  listBranches(projectId: string, repositoryId: string, cursor: string | null): ReturnType<AzureClient["listBranches"]>;
  /** Returns a URL only for the displayed SHA. A changed tip requires a new submission. */
  confirmBranch(projectId: string, repositoryId: string, refName: string, commitId: string):
    Promise<{ commitId: string; resourceUrl?: string }>;
}
