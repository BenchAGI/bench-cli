// copy-assets.mjs — copy the JS launcher assets (boot cinematic) that tsc does
// not compile (src/v2/assets/*.mjs) into dist/v2/assets/ after a build.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // scripts/
const repo = dirname(here);
const src = join(repo, "src", "v2", "assets");
const dest = join(repo, "dist", "v2", "assets");

await mkdir(dest, { recursive: true });
let n = 0;
for (const f of await readdir(src)) {
  if (f.endsWith(".mjs")) {
    await copyFile(join(src, f), join(dest, f));
    n += 1;
  }
}
console.log(`copy-assets: ${n} asset(s) → dist/v2/assets/`);
