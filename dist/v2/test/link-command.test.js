import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
}
function writeJson(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}
async function listen(handler) {
    const server = createServer((req, res) => {
        handler(req, res).catch((err) => {
            writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return {
        apiBase: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
async function runBenchagi(args, env) {
    const child = spawn(process.execPath, ["./bin/benchagi.mjs", ...args], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const status = await new Promise((resolve) => {
        child.on("close", (code) => resolve(code));
    });
    return {
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
    };
}
test("benchagi link <code> saves private bridge credentials from the pairing API", async () => {
    const requests = [];
    const server = await listen(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/aurelius/bridge/pairing/complete") {
            const body = await readJson(req);
            requests.push({ method: req.method, url: req.url, body });
            writeJson(res, 200, {
                tenantId: "tenant-test",
                machineId: body.machineId,
                token: "bridge-token-test",
                expiresAt: "2027-01-01T00:00:00.000Z",
            });
            return;
        }
        if (req.method === "GET" && req.url?.startsWith("/v1/aurelius/bridge/status")) {
            writeJson(res, 200, { state: "paired_offline" });
            return;
        }
        writeJson(res, 404, { error: "not found" });
    });
    const home = mkdtempSync(join(tmpdir(), "benchagi-link-home-"));
    try {
        const result = await runBenchagi(["link", "12345678"], {
            HOME: home,
            BENCHAGI_API_BASE: server.apiBase,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /This Mac is paired/);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].body.code, "12345678");
        assert.equal(typeof requests[0].body.machineId, "string");
        assert.equal(typeof requests[0].body.machineFingerprint, "string");
        const aureliusDir = join(home, ".aurelius");
        const bridgePath = join(aureliusDir, "bridge.json");
        const machinePath = join(aureliusDir, "machine.json");
        const bridge = JSON.parse(readFileSync(bridgePath, "utf8"));
        assert.equal(bridge.tenantId, "tenant-test");
        assert.equal(bridge.token, "bridge-token-test");
        assert.equal(bridge.apiBase, server.apiBase);
        assert.equal(statSync(aureliusDir).mode & 0o777, 0o700);
        assert.equal(statSync(bridgePath).mode & 0o777, 0o600);
        assert.equal(statSync(machinePath).mode & 0o777, 0o600);
    }
    finally {
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
});
test("benchagi link refuses to write bridge credentials for malformed pairing responses", async () => {
    const server = await listen(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/aurelius/bridge/pairing/complete") {
            await readJson(req);
            writeJson(res, 200, { tenantId: "tenant-test", machineId: "mac-test" });
            return;
        }
        writeJson(res, 404, { error: "not found" });
    });
    const home = mkdtempSync(join(tmpdir(), "benchagi-link-home-"));
    try {
        const result = await runBenchagi(["link", "12345678"], {
            HOME: home,
            BENCHAGI_API_BASE: server.apiBase,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Pairing service response missing token/);
        assert.equal(existsSync(join(home, ".aurelius", "bridge.json")), false);
    }
    finally {
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
});
