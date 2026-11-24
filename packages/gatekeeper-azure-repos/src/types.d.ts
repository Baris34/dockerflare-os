/** The Azure Repos branch and revision that the user attached to this workspace. */
export interface AzureReposBranch {
  /**
   * Returns the selected revision, including its full Git commit ID. Use that ID with
   * createWorktree to inspect or edit the files. This revision stays fixed if the branch moves.
   */
  getCheckout(): Promise<AzureReposCheckout>;
}

/** Identifies the repository, branch and exact revision selected by the user. */
export interface AzureReposCheckout {
  /** Azure DevOps project name. */
  project: string;
  /** Git repository name. */
  repository: string;
  /** Fully qualified branch name, for example refs/heads/release/1.0. */
  refName: string;
  /** Full 40-character Git commit ID of the selected revision. */
  commitId: string;
}
