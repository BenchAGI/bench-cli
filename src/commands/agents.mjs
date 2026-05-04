// `bench agents` — list configured agents.
import { parseArgs } from "../lib/args.mjs";
import { runOpenclawJson } from "../lib/openclaw.mjs";
import { table, c, truncate } from "../lib/format.mjs";

const HELP = `bench agents [options]

List configured OpenClaw agents (id, name, model, default flag).

Options:
  --json    Output raw JSON
  -h, --help
`;

export async function cmdAgents(argv) {
  const { flags } = parseArgs(argv, {
    booleanFlags: ["help", "json"],
    aliases: { h: "help" },
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const agents = await runOpenclawJson(["agents", "list", "--json"]);
  if (flags.json) {
    process.stdout.write(JSON.stringify(agents, null, 2) + "\n");
    return 0;
  }
  const rows = agents.map((a) => [
    a.isDefault ? c.green("●") : " ",
    a.id,
    a.identityName ?? "",
    truncate(a.model ?? "", 32),
    a.bindings ?? 0,
  ]);
  process.stdout.write(
    table(["", "ID", "NAME", "MODEL", "BINDS"], rows) + "\n",
  );
  return 0;
}
