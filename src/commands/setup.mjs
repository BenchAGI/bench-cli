// `bench setup` — guided / non-interactive doctor for end-customer install.
//
// Goal: when a brand-new customer runs `bench setup` they should be able to
// answer the question "is BenchAGI working on my machine right now?" in <30s.
import { parseArgs } from "../lib/args.mjs";
import { runOpenclaw, runOpenclawJson, OPENCLAW_BIN } from "../lib/openclaw.mjs";
import { c } from "../lib/format.mjs";

const HELP = `bench setup [options]

Run a guided readiness check for the BenchAGI CLI:
  - openclaw is installed
  - gateway is reachable
  - at least one agent is configured
  - default agent responds (optional ping)

Options:
  --non-interactive   Skip the live ping; just check binaries + gateway + agents
  --json              Emit JSON summary
  --fix               Attempt safe repairs by invoking \`openclaw doctor --repair --non-interactive\`
  -h, --help
`;

export async function cmdSetup(argv) {
  const { flags } = parseArgs(argv, {
    booleanFlags: ["help", "non-interactive", "json", "fix"],
    aliases: { h: "help" },
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const checks = [];

  // 1. openclaw binary
  checks.push(await runCheck("openclaw on PATH", async () => {
    const { code, stdout } = await runOpenclaw(["--version"]);
    if (code !== 0) throw new Error(`openclaw --version exited ${code}`);
    return stdout.trim().split("\n").pop();
  }));

  // 2. gateway status
  let statusData = null;
  checks.push(await runCheck("gateway reachable", async () => {
    statusData = await runOpenclawJson(["status", "--json"]);
    const gw = statusData.gateway ?? {};
    if (!(gw.reachable === true || gw.connected === true)) {
      throw new Error(
        `gateway unreachable at ${gw.url ?? "(unknown url)"}; ` +
          (gw.error ? `error=${gw.error}` : "no error reported"),
      );
    }
    return `${gw.url} (${gw.connectLatencyMs ?? "?"}ms)`;
  }));

  // 3. agents configured
  checks.push(await runCheck("at least one agent configured", async () => {
    const agents = statusData?.agents?.agents ?? [];
    if (!agents.length) throw new Error("no agents configured (run `openclaw agents add`)");
    const def = statusData?.agents?.defaultId;
    return `${agents.length} agents${def ? `, default=${def}` : ""}`;
  }));

  // 4. default agent ping (optional, skipped in non-interactive mode)
  if (!flags["non-interactive"]) {
    const defaultId = statusData?.agents?.defaultId;
    if (defaultId) {
      checks.push(await runCheck(`ping default agent (${defaultId})`, async () => {
        const { code, stdout, stderr } = await runOpenclaw([
          "agent",
          "--agent",
          defaultId,
          "--timeout",
          "30",
          "--thinking",
          "minimal",
          "--message",
          "ping",
          "--json",
        ]);
        if (code !== 0) {
          throw new Error(stderr.split("\n").slice(-3).join(" ").trim() || `exit=${code}`);
        }
        const len = stdout.length;
        return `replied ok (${len} bytes)`;
      }));
    }
  }

  if (flags.fix) {
    checks.push(await runCheck("openclaw doctor --repair --non-interactive", async () => {
      const { code, stdout } = await runOpenclaw([
        "doctor",
        "--repair",
        "--non-interactive",
      ]);
      if (code !== 0) throw new Error(`doctor exited ${code}`);
      const lines = stdout
        .split("\n")
        .filter((l) => l.trim() && !/^Config warnings:|^- plugins\.|^🦞/.test(l));
      return lines.slice(-3).join(" | ").trim() || "ok";
    }));
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({ checks }, null, 2) + "\n");
  } else {
    for (const r of checks) {
      const dot = r.ok ? c.green("✔") : c.red("✘");
      const detail = r.ok ? c.dim(r.detail ?? "") : c.red(r.error);
      process.stdout.write(`${dot}  ${r.name}  ${detail}\n`);
    }
    const failed = checks.filter((r) => !r.ok);
    if (!failed.length) {
      process.stdout.write(
        "\n" +
          c.green("BenchAGI CLI is ready.") +
          "  Try: " +
          c.cyan("bench feed") +
          " or " +
          c.cyan("bench ask aurelius --high \"hi\"") +
          "\n",
      );
    } else {
      process.stdout.write(
        "\n" +
          c.red(`${failed.length} check(s) failed.`) +
          c.dim("  Run `openclaw doctor` for guided repairs, or `bench setup --fix`.\n"),
      );
    }
  }
  return checks.every((r) => r.ok) ? 0 : 1;
}

async function runCheck(name, fn) {
  try {
    const detail = await fn();
    return { name, ok: true, detail: typeof detail === "string" ? detail : "" };
  } catch (err) {
    return { name, ok: false, error: err?.message ?? String(err) };
  }
}
