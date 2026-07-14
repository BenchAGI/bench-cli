import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

export type PathResolution = {
  name: string;
  winner: string | null;
  candidates: string[];
  realTargets: string[];
  shadowed: boolean;
};

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function inspectPathResolution(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PathResolution> {
  const candidates: string[] = [];
  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!directory.trim()) continue;
    const candidate = resolve(directory, name);
    if (await isExecutable(candidate) && !candidates.includes(candidate)) candidates.push(candidate);
  }
  const realTargets: string[] = [];
  for (const candidate of candidates) {
    const target = await realpath(candidate).catch(() => candidate);
    if (!realTargets.includes(target)) realTargets.push(target);
  }
  return {
    name,
    winner: candidates[0] || null,
    candidates,
    realTargets,
    shadowed: realTargets.length > 1,
  };
}

export async function inspectCliPathShadows(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PathResolution[]> {
  return await Promise.all(["excalibur", "benchagi", "bench"].map((name) => inspectPathResolution(name, env)));
}
