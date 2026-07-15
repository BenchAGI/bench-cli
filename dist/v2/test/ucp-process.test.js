import assert from "node:assert/strict";
import { test } from "node:test";
import { nonSecretChildEnvironment } from "../ucp/process.js";
test("ordinary UCP subprocesses inherit operational context but no ambient credentials", () => {
    const environment = nonSecretChildEnvironment({
        HOME: "/private/operator",
        LANG: "en_US.UTF-8",
        PATH: "/tmp/path-shadow",
        GH_TOKEN: "synthetic-canary",
        BENCHAGI_API_TOKEN: "synthetic-canary",
        NODE_OPTIONS: "--require=/tmp/inject.js",
    });
    assert.equal(environment.HOME, "/private/operator");
    assert.equal(environment.LANG, "en_US.UTF-8");
    assert.match(environment.PATH || "", /^\/usr\/bin:\/bin:/);
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.BENCHAGI_API_TOKEN, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
});
