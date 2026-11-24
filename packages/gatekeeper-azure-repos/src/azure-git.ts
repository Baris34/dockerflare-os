import { gitPullTransferOf } from "@gadgets/gatekeeper-kit/git-pull-transfer";
import { emptyPackBytes } from "@gadgets/gatekeeper-kit/git-transport";
import type { GitOid, GitPullHints, GitPullTransfer } from "@gadgets/workshop-shared/gatekeeper";
import { AzureClient, type AzureEnv } from "./azure-client";
import { fetchSnapshotPack } from "./azure-git-snapshot";

/** Supply only the content of the revision authorized by the resource picker. */
export async function pullAzureGit(env: AzureEnv, pat: string, selection: {
  projectId: string; repositoryId: string; commitId: GitOid;
}, oids: GitOid[], hints: GitPullHints): Promise<GitPullTransfer> {
  const { projectId, repositoryId, commitId } = selection;
  const client = new AzureClient(env, pat);
  if (hints.type === "commit") {
    if (oids.some(oid => oid !== commitId)) throw new Error("Only the attached Azure revision is available.");
  } else if (!await client.hasSnapshotObjects(projectId, repositoryId, commitId, oids)) {
    throw new Error("Git object is outside the attached Azure revision.");
  }
  if (oids.length === 0 || (hints.type === "commit" && hints.haves?.includes(commitId))) {
    return gitPullTransferOf(new Response(await emptyPackBytes() as BodyInit).body!, {shallow: [], unshallow: []});
  }
  const pack = await fetchSnapshotPack(commitId, body => client.gitUploadPack(projectId, repositoryId, body));
  return gitPullTransferOf(pack, {shallow: [commitId], unshallow: []});
}
