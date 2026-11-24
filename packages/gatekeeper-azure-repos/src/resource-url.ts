/** Immutable source selected in this collection. Human-readable project/repository names are display data. */
export interface BranchSelection {
  projectId: string;
  repositoryId: string;
  refName: string;
  commitId: string;
}

const prefix = "https://azure-repos.invalid/selection/";
export const BRANCH_URL_PATTERN = prefix + ":selectionId";
const v1 = prefix + "v1-";
const encoder = new TextEncoder();

/** The connection authenticates this context without putting its identity into the URL. */
type SelectionContext = {collection: string; collectionId: string; id: string};

function associatedData({collection, collectionId, id}: SelectionContext): Uint8Array {
  return encoder.encode(JSON.stringify(["Azure Repos selection v1", collection, collectionId, id]));
}

/**
 * Workshop also exposes a connection's original URL before an observer's account has been verified.
 * Encrypt the selected identifiers with this account's persistent key. One key serves any number of
 * selections, including retried confirmations and workspace rebinds after a restart or reconnect.
 */
export async function sealSelection(
    keyBytes: Uint8Array<ArrayBuffer>, context: SelectionContext, selection: BranchSelection): Promise<string> {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: associatedData(context)},
    key, encoder.encode(JSON.stringify(selection)));
  const envelope = new Uint8Array(iv.length + encrypted.byteLength);
  envelope.set(iv);
  envelope.set(new Uint8Array(encrypted), iv.length);
  return v1 + envelope.toBase64({alphabet: "base64url", omitPadding: true});
}

/** Recover only a selection that the same account confirmed for this collection and Azure identity. */
export async function openSelection(
    keyBytes: Uint8Array<ArrayBuffer> | undefined, context: SelectionContext, url: string): Promise<BranchSelection> {
  if (keyBytes && url.startsWith(v1)) {
    try {
      const raw = url.slice(v1.length);
      const envelope = Uint8Array.fromBase64(raw, {alphabet: "base64url"});
      if (envelope.toBase64({alphabet: "base64url", omitPadding: true}) !== raw) throw new Error();
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt({
        name: "AES-GCM", iv: envelope.subarray(0, 12), additionalData: associatedData(context),
      }, key, envelope.subarray(12));
      // Authenticated by the key held exclusively by this account's confirmation flow.
      return JSON.parse(new TextDecoder().decode(plaintext)) as BranchSelection;
    } catch {
      // An unknown account, malformed encoding, and tampering have the same public outcome.
    }
  }
  throw new Error("Select this branch using your connected Azure Repos account.");
}
