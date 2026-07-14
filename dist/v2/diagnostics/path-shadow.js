import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
async function isExecutable(path) {
    try {
        await access(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
export async function inspectPathResolution(name, env = process.env) {
    const candidates = [];
    for (const directory of (env.PATH || "").split(delimiter)) {
        if (!directory.trim())
            continue;
        const candidate = resolve(directory, name);
        if (await isExecutable(candidate) && !candidates.includes(candidate))
            candidates.push(candidate);
    }
    const realTargets = [];
    for (const candidate of candidates) {
        const target = await realpath(candidate).catch(() => candidate);
        if (!realTargets.includes(target))
            realTargets.push(target);
    }
    return {
        name,
        winner: candidates[0] || null,
        candidates,
        realTargets,
        shadowed: realTargets.length > 1,
    };
}
export async function inspectCliPathShadows(env = process.env) {
    return await Promise.all(["excalibur", "benchagi", "bench"].map((name) => inspectPathResolution(name, env)));
}
