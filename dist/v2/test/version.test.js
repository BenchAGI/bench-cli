import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLI_VERSION } from "../commands/version.js";
test("CLI_VERSION matches package.json version", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(resolve(here, "../../../package.json"), "utf8"));
    assert.equal(CLI_VERSION, pkg.version);
});
