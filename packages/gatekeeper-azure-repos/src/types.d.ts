/** The Azure Repos branch and revision that the user attached to this workspace. */
export interface AzureReposBranch {
  /**
   * Returns the selected revision, including its full Git commit ID. Use that ID with
   * createWorktree to inspect or edit the files. This revision stays fixed if the branch moves.
   */
  getCheckout(): Promise<AzureReposCheckout>;

  /**
   * Propose publishing the worktree's committed changes and opening a pull request into
   * the attached branch. Pass the full ID returned by worktree.commit(message). The worktree
   * must start at the exact revision returned by getCheckout(). Returns the generated source
   * branch; use getPublication(sourceRefName) to retrieve the pull request once published.
   */
  proposePullRequest(commitId: string, title: string, description?: string): Promise<AzurePullRequestProposal>;

  /** Get the status of a proposal made through this connection and the link to its published PR. */
  getPublication(sourceRefName: string): Promise<AzurePublication>;
}

/** The branches of a proposed pull request in the attached repository. */
export interface AzurePullRequestProposal {
  /** Fully qualified agents/ branch generated for this proposal. */
  sourceRefName: string;
  /** Fully qualified branch originally attached to this workspace. */
  targetRefName: string;
}

/** A proposal's local publication status. Published proposals include the Azure PR ID and web URL. */
export type AzurePublication = AzurePullRequestProposal & (
  { status: "pending" | "rejected" } | { status: "published"; pullRequestId: number; url: string }
);

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
