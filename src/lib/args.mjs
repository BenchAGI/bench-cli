// Minimal positional + flag parser. We avoid commander/yargs to keep
// the install hermetic and the source easy to read.

/**
 * Parse argv into { positionals, flags }.
 * Flags can be `--name`, `--name=value`, or `--name value`.
 * Boolean flags accept `--no-name` to set false, and known boolean keys
 * may be passed as the caller's hint via `booleanFlags`.
 *
 * @param {string[]} argv
 * @param {{ booleanFlags?: string[], aliases?: Record<string,string> }} [opts]
 */
export function parseArgs(argv, opts = {}) {
  const booleanFlags = new Set(opts.booleanFlags ?? []);
  const aliases = opts.aliases ?? {};
  const flags = {};
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("--no-")) {
      const key = canonical(tok.slice(5), aliases);
      flags[key] = false;
      i += 1;
      continue;
    }
    if (tok.startsWith("--")) {
      let key;
      let value;
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        key = canonical(tok.slice(2, eq), aliases);
        value = tok.slice(eq + 1);
      } else {
        key = canonical(tok.slice(2), aliases);
        const next = argv[i + 1];
        if (booleanFlags.has(key) || next === undefined || next.startsWith("--")) {
          value = true;
          i += 1;
          flags[key] = value;
          continue;
        }
        value = next;
        i += 2;
        flags[key] = value;
        continue;
      }
      flags[key] = value;
      i += 1;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // Short flag(s). We only support single-char shorts mapped via aliases.
      const key = canonical(tok.slice(1), aliases);
      const next = argv[i + 1];
      if (booleanFlags.has(key) || next === undefined || next.startsWith("-")) {
        flags[key] = true;
        i += 1;
      } else {
        flags[key] = next;
        i += 2;
      }
      continue;
    }
    positionals.push(tok);
    i += 1;
  }
  return { positionals, flags };
}

function canonical(name, aliases) {
  return aliases[name] ?? name;
}
