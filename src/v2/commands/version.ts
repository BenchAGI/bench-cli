// `benchagi version`.

import { println } from "../render/ansi.js";

export const CLI_VERSION = "1.0.0-beta.15";

export async function commandVersion(invocationName = "benchagi"): Promise<void> {
  println(`${invocationName} ${CLI_VERSION}`);
  println(`node ${process.version}`);
  println(`platform ${process.platform}-${process.arch}`);
}
