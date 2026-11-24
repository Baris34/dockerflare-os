// The Wrangler text module ships the standalone contract to the agent. Generate it on Windows
// as well, where standard Git checkouts materialize file symlinks as a one-line target name.
import { copyFile, mkdir } from "node:fs/promises";

const target = new URL("src/generated/", import.meta.url);
await mkdir(target, {recursive: true});
await copyFile(new URL("src/types.d.ts", import.meta.url), new URL("branch-types.txt", target));
