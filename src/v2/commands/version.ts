// `benchagi version`.

import { println } from "../render/ansi.js";

export const CLI_VERSION = "1.0.0-beta.9";

export async function commandVersion(): Promise<void> {
  println(`benchagi ${CLI_VERSION}`);
  println(`node ${process.version}`);
  println(`platform ${process.platform}-${process.arch}`);
}
