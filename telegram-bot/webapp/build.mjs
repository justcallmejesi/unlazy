#!/usr/bin/env node
// Refresh the Mini App's copy of the questionnaire definitions.
// Zero dependencies. Node 16+.
//
// The app must not restate the items, options, or bands: a copy that drifts
// would score the same answers differently in the window and in the chat. The
// copy is byte-identical to src/instruments.mjs and a test fails when it is
// stale, so this script is the only way it changes.
//
//   node telegram-bot/webapp/build.mjs           refresh the copy
//   node telegram-bot/webapp/build.mjs --check   exit 1 if it is stale

import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCE = join(HERE, "..", "src", "instruments.mjs");
export const COPY = join(HERE, "instruments.mjs");

export function isCurrent() {
  try {
    return readFileSync(SOURCE, "utf8") === readFileSync(COPY, "utf8");
  } catch (error) {
    return false;
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("build.mjs");
if (invokedDirectly) {
  if (process.argv.includes("--check")) {
    if (isCurrent()) {
      console.log("webapp/instruments.mjs is current");
      process.exit(0);
    }
    console.error("webapp/instruments.mjs is stale, run: node telegram-bot/webapp/build.mjs");
    process.exit(1);
  }
  copyFileSync(SOURCE, COPY);
  console.log("copied src/instruments.mjs to webapp/instruments.mjs");
}
