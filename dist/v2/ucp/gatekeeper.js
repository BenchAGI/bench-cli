import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { parseOnePasswordRef } from "./config.js";
import { nonSecretChildEnvironment, runCaptured } from "./process.js";
import { UcpDeniedError } from "./types.js";
const TOUCH_ID_SCRIPT = `
import Foundation
import LocalAuthentication

let reason = ProcessInfo.processInfo.environment["EXCALIBUR_TOUCH_ID_REASON"] ?? "Authorize protected Excalibur effect"
let context = LAContext()
context.localizedFallbackTitle = ""
var policyError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &policyError) else {
  fputs("biometric user presence unavailable\\n", stderr)
  exit(2)
}
let semaphore = DispatchSemaphore(value: 0)
var accepted = false
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, _ in
  accepted = success
  semaphore.signal()
}
if semaphore.wait(timeout: .now() + 60) == .timedOut { exit(3) }
exit(accepted ? 0 : 1)
`;
const TOUCH_ID_AVAILABILITY_SCRIPT = `
import Foundation
import LocalAuthentication
let context = LAContext()
var error: NSError?
exit(context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) ? 0 : 1)
`;
export class MacTouchIdVerifier {
    async available() {
        try {
            await access("/usr/bin/swift", constants.X_OK);
            if (process.platform !== "darwin")
                return false;
            const result = await runCaptured("/usr/bin/swift", ["-"], {
                input: TOUCH_ID_AVAILABILITY_SCRIPT,
                timeoutMs: 15_000,
                maxBytes: 2 * 1024,
            });
            return result.code === 0;
        }
        catch {
            return false;
        }
    }
    async verify(purpose) {
        if (!(await this.available())) {
            throw new UcpDeniedError("GATEKEEPER_USER_PRESENCE_UNAVAILABLE", "Touch ID verification is unavailable; no secret was accessed");
        }
        const result = await runCaptured("/usr/bin/swift", ["-"], {
            input: TOUCH_ID_SCRIPT,
            env: {
                ...nonSecretChildEnvironment(),
                EXCALIBUR_TOUCH_ID_REASON: purpose.slice(0, 240),
            },
            timeoutMs: 75_000,
            maxBytes: 4 * 1024,
        });
        if (result.code !== 0) {
            throw new UcpDeniedError("GATEKEEPER_USER_PRESENCE_DENIED", "Touch ID was unavailable, cancelled, or rejected; no secret was accessed");
        }
    }
}
const CHILD_CONTEXT_ENV = new Set([
    "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "NO_COLOR",
    "OP_ACCOUNT",
]);
function isolatedChildEnvironment(source, injectedName) {
    const isolated = { PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin" };
    for (const [name, value] of Object.entries(source)) {
        if (name === injectedName)
            continue;
        if (!CHILD_CONTEXT_ENV.has(name) && !/^UCP_(?:HTTP|GITHUB)_/.test(name))
            continue;
        isolated[name] = value;
    }
    return isolated;
}
export class GateKeeper {
    verifier;
    opBin;
    oneShotPresence = new Map();
    constructor(verifier = new MacTouchIdVerifier(), opBin = "op") {
        this.verifier = verifier;
        this.opBin = opBin;
    }
    async status() {
        const [which, userPresence] = await Promise.all([
            runCaptured("/usr/bin/which", [this.opBin], { timeoutMs: 1_000, maxBytes: 1_024 }),
            this.verifier.available(),
        ]);
        return { installed: which.code === 0, userPresence };
    }
    async authorizeProtectedEffect(effectId, purpose) {
        await this.verifier.verify(purpose);
        // This is deliberately in-memory, single-process, and single-use. A plain
        // grant JSON file can never suppress user presence for secret material.
        this.oneShotPresence.set(effectId, Date.now() + 60_000);
    }
    async runSecretCommand(input) {
        parseOnePasswordRef(input.secretRef);
        if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(input.envName)) {
            throw new UcpDeniedError("GATEKEEPER_ENV_INVALID", "GateKeeper child environment name is invalid");
        }
        const now = Date.now();
        const oneShotExpiry = this.oneShotPresence.get(input.effectId) || 0;
        this.oneShotPresence.delete(input.effectId);
        if (oneShotExpiry <= now)
            await this.verifier.verify(input.purpose);
        const status = await this.status();
        if (!status.installed) {
            throw new UcpDeniedError("GATEKEEPER_1PASSWORD_MISSING", "1Password CLI is unavailable; no secret was accessed", "missing_config");
        }
        // The parent never receives the secret value. `op run` resolves the reference,
        // injects it into exactly one child environment, and masks it in captured output.
        const processResult = await runCaptured(this.opBin, [
            "run",
            "--env-file=/dev/fd/3",
            "--",
            input.command,
            ...input.args,
        ], {
            cwd: input.cwd,
            // `op` and its child receive ordinary process context, but never inherit a
            // second ambient credential. The named 1Password field is the only secret
            // capability deliberately introduced into this subtree.
            env: isolatedChildEnvironment(input.env ?? process.env, input.envName),
            input: input.input,
            extraFdInput: `${input.envName}=${input.secretRef}\n`,
            timeoutMs: input.timeoutMs,
            maxBytes: input.maxBytes,
        });
        return {
            process: processResult,
            audit: {
                reference: input.secretRef,
                purpose: input.purpose,
                presence: "per_access",
                ttlSeconds: 0,
            },
        };
    }
}
