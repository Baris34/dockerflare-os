import { ActionDescriptionBuilder, MAX_ACTION_DESCRIPTION_BYTES } from "@gadgets/gatekeeper-kit/action-description";
import { diffTextLines, MAX_DIFF_BLOB_BYTES, MAX_DIFF_LINES_PER_FILE, visitTreeDiff, type GitTreeEntry } from "@gadgets/gatekeeper-kit/git-diff";
import type { ActionDescription, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { decodeBlobText, type WorkspaceGitCache } from "./git-cache";
import { parseGitCommitRefs, parseGitTree } from "./git-codec";

const encoder = new TextEncoder();
const limitError = () => new Error("Git push review exceeds the review limit. Submit a smaller change.");

function commitRefs(payload: Uint8Array) {
  try { return parseGitCommitRefs(payload); }
  catch { throw new Error("Cannot review malformed Git commit headers."); }
}

/** A lossless line representation: explicit encodings for text, fixed-width hex rows otherwise. */
function reviewContent(bytes: Uint8Array) {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "UTF-16LE" :
    bytes[0] === 0xfe && bytes[1] === 0xff ? "UTF-16BE" : undefined;
  if (utf16 || !bytes.includes(0)) {
    let text: string | undefined;
    try {
      // Strip just the BOM identified above. A second BOM is part of the actual content.
      text = new TextDecoder(utf16 ?? "utf-8", {fatal: true, ignoreBOM: true}).decode(utf16 ? bytes.subarray(2) : bytes);
    } catch { /* Malformed encodings are reviewable as raw bytes. */ }
    if (text !== undefined) {
      // Bound the number of diff line objects even when every input character is an LF.
      let lines = 0;
      for (let i = 0; i < text.length; ++i) if (text.charCodeAt(i) === 10 && ++lines > MAX_DIFF_LINES_PER_FILE) throw limitError();
      return {format: utf16 ? utf16 + " with BOM" : "UTF-8", text};
    }
  }
  const rowWidth = 16;
  if (bytes.length > rowWidth * MAX_DIFF_LINES_PER_FILE) throw limitError();
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += rowWidth) {
    rows.push(bytes.subarray(i, i + rowWidth).toHex().match(/../g)!.join(" "));
  }
  return {format: "binary hex, 16 bytes per row", text: rows.join("\n") + "\n"};
}

/** Build human-only approval fields from local immutable objects. Never grant the submitting remote those objects. */
export async function reviewGitPush(cache: WorkspaceGitCache, base: GitOid, head: GitOid, action: ActionDescription): Promise<ActionDescription> {
  const budget = MAX_ACTION_DESCRIPTION_BYTES - encoder.encode(JSON.stringify(action)).length;
  if (budget <= 0) throw limitError();
  const preview = new ActionDescriptionBuilder(undefined, {maxBytes: budget});
  let inputBytes = 0;
  // Bound work even when many large objects yield only a few lines of output.
  function charge(bytes: number) {
    inputBytes += bytes + 128;
    if (inputBytes > 8 * 1024 * 1024) throw limitError();
  }

  function object(oid: string, type: "tree" | "commit") {
    if (cache.localObjectType(oid) !== type) throw new Error("Git objects needed for the push review are unavailable.");
    const bytes = cache.readLocalObject(oid)!.payload;
    charge(bytes.length);
    return bytes;
  }
  const source = {
    async getTree(oid: string) {
      const payload = object(oid, "tree");
      let entries;
      try { entries = parseGitTree(payload); }
      catch { throw new Error("Cannot review malformed Git trees or non-UTF-8 paths."); }
      if (entries.some(e => !e.name || e.name === "." || e.name === ".." || e.name.includes("/")) ||
          new Set(entries.map(e => e.name)).size !== entries.length) throw new Error("Cannot review ambiguous Git paths.");
      return entries;
    },
  };
  function side(entry: GitTreeEntry | undefined, modeOnly: boolean) {
    if (!entry) return {label: "/dev/null", text: ""};
    if (entry.mode === "160000") return {label: `160000 submodule ${entry.oid}`, text: ""};
    const reader = cache.openLocalBlob(entry.oid);
    if (!reader) throw new Error("A changed Git blob is unavailable for review.");
    const label = `${entry.mode} blob ${entry.oid} (${reader.size} bytes)`;
    if (modeOnly) return {label, text: ""};
    if (reader.size > MAX_DIFF_BLOB_BYTES) throw limitError();
    charge(reader.size);
    const {format, text} = reviewContent(reader.read(0, reader.size));
    return {label: label + " [" + format + "]", text};
  }

  const baseTree = commitRefs(object(base, "commit")).tree;
  const chain = [];
  for (let id = head; id !== base;) {
    if (chain.length === 32) throw limitError();
    const payload = object(id, "commit");
    if (payload.length > budget) throw limitError();
    const {tree, parents} = commitRefs(payload);
    if (parents.length !== 1) throw new Error("Each reviewed commit must have a single parent leading back to the selected base.");
    chain.push({id, tree, payload});
    id = parents[0];
  }
  if (chain[0]?.tree === baseTree || chain.length === 0) throw new Error("There are no file changes to publish.");

  let oldTree = baseTree;
  for (const commit of chain.toReversed()) {
    preview.verbatim("Commit", commit.id + "\n" + decodeBlobText(commit.payload, "Commit metadata"));
    await visitTreeDiff(source, oldTree, commit.tree, ({path, oldEntry, newEntry}) => {
      const modeOnly = oldEntry !== undefined && oldEntry.oid === newEntry?.oid;
      const before = side(oldEntry, modeOnly);
      const after = side(newEntry, modeOnly);
      const lines = [JSON.stringify(path), "--- " + before.label, "+++ " + after.label];
      const {hunks} = diffTextLines(before.text, after.text);
      if (!hunks.length && before.text !== after.text) throw new Error("Cannot render this Git text change exactly.");
      for (const hunk of hunks) {
        lines.push(hunk.header);
        for (const line of hunk.lines) {
          const prefix = line.kind === "added" ? "+" : line.kind === "removed" ? "-" :
            line.oldLineNumber === undefined ? "" : " ";
          lines.push(prefix + line.text);
        }
      }
      preview.verbatim("File change", lines.join("\n"));
    });
    oldTree = commit.tree;
  }
  const rendered = preview.finish();
  if (!rendered.descriptionIsComplete) throw limitError();
  const reviewed = {...action, descriptionIsComplete: false, fields: [...action.fields ?? [], ...rendered.fields ?? []]};
  if (encoder.encode(JSON.stringify(reviewed)).length > MAX_ACTION_DESCRIPTION_BYTES) throw limitError();
  return reviewed;
}
