import { encodePktLine, FLUSH_PKT, PktLineParser, pktText } from "@gadgets/gatekeeper-kit/git-transport";

/** Fetch the selected revision with depth one over classic smart HTTP, including its trees and blobs. */
export async function fetchSnapshotPack(commitId: string, upload: (body: Uint8Array) => Promise<Response>) {
  if (!/^[0-9a-f]{40}$/.test(commitId)) throw new Error("Invalid Azure Git revision.");
  const body = await new Blob([
    encodePktLine(`want ${commitId} side-band-64k no-progress`),
    encodePktLine("deepen 1"), FLUSH_PKT, encodePktLine("done"),
  ]).arrayBuffer();
  const response = await upload(new Uint8Array(body));
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Azure Git fetch failed (HTTP ${response.status}).`);
  }
  const parser = new PktLineParser();
  let state: "shallow" | "negotiate" | "pack" | "done" = "shallow";
  let received = 0;
  let packBytes = 0;
  return response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.length;
      if (received > 64 * 1024 * 1024) throw new Error("Azure Git snapshot exceeds the 64 MiB pilot transfer limit.");
      let packets: ReturnType<PktLineParser["push"]>;
      try { packets = parser.push(chunk); } catch { throw new Error("Invalid Azure Git packet framing."); }
      for (const item of packets) {
        if (state === "shallow") {
          if (item.kind !== "data" || pktText(item.data) !== "shallow " + commitId) {
            throw new Error("Azure Git rejected or did not confirm the selected shallow revision.");
          }
          state = "negotiate";
          continue;
        }
        if (item.kind === "flush" && state === "negotiate") continue;
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
