import type { GitCache } from "@gadgets/workshop-shared/gatekeeper";
import { isCredentialsExpired } from "@gadgets/gatekeeper-kit/credentials";
import { parsePktItems, pktText, pushGitRefUpdate, ZERO_OID, type PktItem } from "@gadgets/gatekeeper-kit/git-transport";
import { readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import { AzureAccessDenied, AzureClient, AzureRequestError, requirePublicationBase } from "./azure-client";

type Publication = {
  projectId: string; repositoryId: string; refName: string; commitId: string; head: string;
  sourceRefName: string; title: string; description: string;
};

const agentRef = /^refs\/heads\/agents\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const commit = /^[0-9a-f]{40}$/;

async function receiveAdvertisement(client: AzureClient, input: Publication) {
  const response = await client.gitReceivePack(input.projectId, input.repositoryId);
  const bytes = await readBytesCapped(response, 8 * 1024 * 1024);
  const invalid = new Error("Invalid Azure Git receive-pack advertisement.");
  let items: PktItem[];
  try { items = parsePktItems(bytes); } catch { throw invalid; }
  if (items[0]?.kind !== "data" || pktText(items[0].data) !== "# service=git-receive-pack" ||
      items[1]?.kind !== "flush" || items.at(-1)?.kind !== "flush" || items.length < 4) throw invalid;
  const first = items[2];
  if (first.kind !== "data") throw invalid;
  const fields = pktText(first.data).split("\0");
  if (fields.length !== 2) throw invalid;
  const capabilities = fields[1].split(" ");
  if (!capabilities.includes("report-status")) throw new Error("Azure Git does not advertise report-status for pushes.");
  if (capabilities.some(cap => cap.startsWith("object-format=") && cap !== "object-format=sha1")) {
    throw new Error("Azure Git uses an unsupported object format.");
  }
  let sourceHead: string | undefined;
  for (const item of items.slice(2, -1)) {
    if (item.kind !== "data") throw invalid;
    const ref = item === first ? fields[0] : pktText(item.data);
    if (ref.slice(41) === input.sourceRefName) {
      const sha = ref.slice(0, 40);
      if (ref[40] !== " " || !commit.test(sha) || sha === ZERO_OID || sourceHead !== undefined) throw invalid;
      sourceHead = sha;
    }
  }
  return {sourceHead, sendAgent: capabilities.some(cap => cap.startsWith("agent="))};
}

type PullRequest = NonNullable<Awaited<ReturnType<AzureClient["findPullRequest"]>>>;

function publicationResult(pr: PullRequest, head: string, sourceHead: string | undefined) {
  const closedAtHead = pr.status !== "active" && pr.head === head;
  if ((pr.head !== undefined && pr.head !== head) || (sourceHead !== head && !closedAtHead)) {
    throw new Error("The Azure pull request no longer identifies the approved commit.");
  }
  return {pullRequestId: pr.pullRequestId, url: pr.url};
}

/** Apply an approved proposal. A retry may observe the branch, the PR, or both already created. */
export async function publishAzurePullRequest(client: AzureClient, cache: Pick<GitCache, "buildPack">, input: Publication) {
  const {projectId, repositoryId, refName, sourceRefName, head} = input;
  if (!agentRef.test(sourceRefName) || !refName.startsWith("refs/heads/") || refName === sourceRefName ||
      !commit.test(head) || !commit.test(input.commitId) || head === ZERO_OID || input.commitId === ZERO_OID || head === input.commitId) {
    throw new Error("Invalid Azure publication ref or revision.");
  }

  const advertisement = await receiveAdvertisement(client, input);
  const findPR = () => client.findPullRequest(projectId, repositoryId, sourceRefName, refName);
  const existing = await findPR();
  if (existing) return publicationResult(existing, head, advertisement.sourceHead);
  if (advertisement.sourceHead !== undefined && advertisement.sourceHead !== head) {
    throw new Error("The Azure publication branch already points to a different commit.");
  }

  if (!advertisement.sourceHead) {
    const target = await client.getBranch(projectId, repositoryId, refName);
    requirePublicationBase(input.commitId, target.commitId);
    const pack = await cache.buildPack();
    try {
      await pushGitRefUpdate(body => client.gitReceivePack(projectId, repositoryId, body), {
        branch: sourceRefName.slice("refs/heads/".length), oldSha: ZERO_OID, newSha: head, sendAgent: advertisement.sendAgent,
      }, pack);
    } catch (error) {
      // A racing apply or a dropped HTTP response can leave the intended ref at Azure.
      if ((await receiveAdvertisement(client, input)).sourceHead !== head) {
        if (error instanceof AzureAccessDenied || error instanceof AzureRequestError || isCredentialsExpired(error)) throw error;
        // Git report-status can contain arbitrary provider/hook output.
        // oxlint-disable-next-line preserve-caught-error -- the provider reason must not escape via cause.
        throw new Error("Azure Git rejected the new branch. Check branch creation permissions and repository policies.");
      }
    }
  }
  let pr: PullRequest;
  try {
    pr = await client.createPullRequest(projectId, repositoryId, sourceRefName, refName, input.title, input.description);
  } catch (error) {
    // An ambiguous create may already have succeeded, even if its PR was subsequently closed.
    const recovered = await findPR();
    if (!recovered) throw error;
    pr = recovered;
  }
  // lastMergeSourceCommit describes Azure's latest merge calculation, which can lag behind
  // changes to the live source branch. Only a closed PR's merge calculation is final.
  const confirmedHead = pr.status === "active" ? (await receiveAdvertisement(client, input)).sourceHead : pr.head;
  return publicationResult(pr, head, confirmedHead);
}
