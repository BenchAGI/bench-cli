import assert from "node:assert/strict";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { inspectPathResolution } from "../diagnostics/path-shadow.js";
test("PATH diagnostics distinguish aliases from true shadow targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "excalibur-path-"));
    const first = join(root, "first");
    const second = join(root, "second");
    const third = join(root, "third");
    await Promise.all([
        import("node:fs/promises").then(({ mkdir }) => mkdir(first)),
        import("node:fs/promises").then(({ mkdir }) => mkdir(second)),
        import("node:fs/promises").then(({ mkdir }) => mkdir(third)),
    ]);
    const target = join(first, "excalibur");
    await writeFile(target, "#!/bin/sh\n", "utf8");
    await chmod(target, 0o755);
    await symlink(target, join(second, "excalibur"));
    const aliasOnly = await inspectPathResolution("excalibur", { PATH: [first, second].join(delimiter) });
    assert.equal(aliasOnly.candidates.length, 2);
    assert.equal(aliasOnly.shadowed, false);
    const other = join(third, "excalibur");
    await writeFile(other, "#!/bin/sh\n", "utf8");
    await chmod(other, 0o755);
    const shadowed = await inspectPathResolution("excalibur", { PATH: [first, third].join(delimiter) });
    assert.equal(shadowed.shadowed, true);
    assert.equal(shadowed.winner, target);
});
