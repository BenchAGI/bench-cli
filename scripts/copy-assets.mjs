// copy-assets.mjs — copy the JS launcher assets (boot cinematic) that tsc does
// not compile (src/v2/assets/*.mjs) into dist/v2/assets/ after a build, plus the
// seat support trees (.claude/.codex) used by local Claude Code and Codex seats.
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

async function copyTree(name) {
  let copied = 0;
  try {
    await cp(join(src, name), join(dest, name), { recursive: true });
    for (const sub of await readdir(join(dest, name), { recursive: true })) {
      if (/\.(mjs|md|json|toml)$/.test(sub)) copied += 1;
    }
  } catch {
    // optional tree missing
  }
  return copied;
}

const claudeFiles = await copyTree(".claude");
const codexFiles = await copyTree(".codex");

// The seat operating contract (CLAUDE.md) — seeded into new Claude seat workspaces.
let contract = 0;
try {
  await copyFile(join(src, "CLAUDE.md"), join(dest, "CLAUDE.md"));
  contract = 1;
} catch {
  // no CLAUDE.md asset -> skip
}
console.log(`copy-assets: ${n} asset(s) + ${claudeFiles} .claude file(s) + ${codexFiles} .codex file(s) + ${contract} contract -> dist/v2/assets/`);
