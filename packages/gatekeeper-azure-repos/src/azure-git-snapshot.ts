import { encodePktLine, FLUSH_PKT, parsePktItems, PktLineParser, pktText, type PktItem } from "@gadgets/gatekeeper-kit/git-transport";
import { readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";

type UploadPack = (body?: Uint8Array) => Promise<Response>;

async function checkedResponse(upload: UploadPack, body?: Uint8Array) {
  const response = await upload(body);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Azure Git fetch failed (HTTP ${response.status}).`);
  }
  return response;
}

function line(item?: PktItem) {
  return item?.kind === "data" ? pktText(item.data) : undefined;
}

function wantCapabilities(bytes: Uint8Array, commitId: string): string {
  const invalid = new Error("Invalid Azure Git service advertisement.");
  let packets: PktItem[];
  try { packets = parsePktItems(bytes); } catch { throw invalid; }
  if (line(packets[0]) !== "# service=git-upload-pack" || packets[1]?.kind !== "flush" ||
      packets.at(-1)?.kind !== "flush") throw invalid;
  const first = line(packets[2]);
  const match = first && /^[0-9a-f]{40} [^\s\0]+\0([^\0]*)$/.exec(first);
  if (!match) throw invalid;
  const caps = new Set(match[1].split(" "));
  if ([...caps].some(cap => cap.startsWith("object-format=") && cap !== "object-format=sha1")) {
    throw new Error("Azure Git uses an unsupported object format.");
  }
  if (!caps.has("shallow")) throw new Error("Azure Git does not support shallow snapshots.");
  if (!packets.slice(2, -1).some(item => line(item)?.startsWith(commitId + " ")) &&
      !caps.has("allow-reachable-sha1-in-want") && !caps.has("allow-tip-sha1-in-want")) {
    throw new Error("Azure Git no longer advertises the selected revision or permits requesting it by ID.");
  }
  const sideband = ["side-band-64k", "side-band"].find(cap => caps.has(cap));
  if (!sideband) throw new Error("Azure Git does not support side-band snapshot transfers.");
  return caps.has("no-progress") ? sideband + " no-progress" : sideband;
}

/** Fetch the selected revision with depth one over classic smart HTTP, including its trees and blobs. */
export async function fetchSnapshotPack(commitId: string, upload: UploadPack) {
  if (!/^[0-9a-f]{40}$/.test(commitId)) throw new Error("Invalid Azure Git revision.");
  const advertisement = await readBytesCapped(await checkedResponse(upload), 8 * 1024 * 1024);
  const caps = wantCapabilities(advertisement, commitId);
  // Native v0 fetch-pack sends "deepen 1" without a trailing LF. The first POST negotiates
  // the boundary. The second replays the entire request because HTTP upload-pack is stateless.
  const want = new Blob([
    encodePktLine(`want ${commitId} ${caps}`), new TextEncoder().encode("000cdeepen 1"), FLUSH_PKT,
  ]);
  const depth = await checkedResponse(upload, new Uint8Array(await want.arrayBuffer()));
  const boundary = "shallow " + commitId;
  const shallowError = "Azure Git rejected or did not confirm the selected shallow revision.";
  const depthBytes = await readBytesCapped(depth, 1024);
  let update: PktItem[];
  try { update = parsePktItems(depthBytes); } catch { throw new Error(shallowError); }
  if (update.length !== 2 || line(update[0]) !== boundary || update[1].kind !== "flush") throw new Error(shallowError);

  const done = new Blob([want, encodePktLine("done")]);
  const response = await checkedResponse(upload, new Uint8Array(await done.arrayBuffer()));
  const parser = new PktLineParser();
  let state: "shallow" | "boundary-flush" | "negotiate" | "pack" | "done" = "shallow";
  let received = 0;
  let packBytes = 0;
  return response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.length;
      if (received > 64 * 1024 * 1024) throw new Error("Azure Git snapshot exceeds the 64 MiB pilot transfer limit.");
      let packets: ReturnType<PktLineParser["push"]>;
      try { packets = parser.push(chunk); } catch { throw new Error("Invalid Azure Git packet framing."); }
      for (const item of packets) {
        if (state === "shallow") {
          if (line(item) !== boundary) throw new Error(shallowError);
          state = "boundary-flush";
          continue;
        }
        if (state === "boundary-flush") {
          if (item.kind !== "flush") throw new Error(shallowError);
          state = "negotiate";
          continue;
        }
        if (item.kind === "flush" && state === "pack") { state = "done"; continue; }
        if (item.kind !== "data" || state === "done") throw new Error("Invalid Azure Git packet sequence.");
        if (state === "negotiate") {
          const line = pktText(item.data);
          if (line !== "NAK") throw new Error("Azure Git rejected the selected revision.");
          state = "pack";
        } else if (item.data[0] === 1) {
          packBytes += item.data.length - 1;
          controller.enqueue(item.data.subarray(1));
        } else if (item.data[0] !== 2) {
          throw new Error("Azure Git rejected the snapshot transfer.");
        }
      }
    },
    flush() {
      parser.finish();
      if (state !== "done" || packBytes < 32) throw new Error("Azure Git returned an incomplete snapshot.");
    },
  }));
}
