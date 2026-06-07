// copy-assets.mjs — copy the JS launcher assets (boot cinematic) that tsc does
// not compile (src/v2/assets/*.mjs) into dist/v2/assets/ after a build, plus the
// seat .claude/ tree (status line + attention hooks + output style + settings).
import { copyFile, cp, mkdir, readdir } from "node:fs/promises";
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

// The .claude/ tree (nested, mixed file types) for the local seat.
let claudeFiles = 0;
try {
  await cp(join(src, ".claude"), join(dest, ".claude"), { recursive: true });
  for (const sub of await readdir(join(dest, ".claude"), { recursive: true })) {
    if (/\.(mjs|md|json)$/.test(sub)) claudeFiles += 1;
  }
} catch {
  // no .claude assets → skip
}
console.log(`copy-assets: ${n} asset(s) + ${claudeFiles} .claude file(s) → dist/v2/assets/`);
