#!/usr/bin/env node
// Refresh the Mini App's copies of the shared definitions.
// Zero dependencies. Node 16+.
//
// The app must not restate the items, options, bands or practices: a copy that
// drifts would score the same answers differently, or word the same practice
// differently, in the window and in the chat. Each copy is byte-identical to
// its source in src/ and a test fails when one is stale, so this script is the
// only way they change.
//
//   node telegram-bot/webapp/build.mjs           refresh the copies
//   node telegram-bot/webapp/build.mjs --check   exit 1 if any is stale

import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHARED = ["instruments.mjs", "selfhelp.mjs"].map((name) => ({
  name,
  source: join(HERE, "..", "src", name),
  copy: join(HERE, name),
}));

function same(entry) {
  try {
    return readFileSync(entry.source, "utf8") === readFileSync(entry.copy, "utf8");
  } catch (error) {
    return false;
  }
}

export function staleCopies() {
  return SHARED.filter((entry) => !same(entry)).map((entry) => entry.name);
}

export function isCurrent() {
  return staleCopies().length === 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("build.mjs");
if (invokedDirectly) {
  if (process.argv.includes("--check")) {
    const stale = staleCopies();
    if (!stale.length) {
      console.log("webapp copies are current: " + SHARED.map((entry) => entry.name).join(", "));
      process.exit(0);
    }
    console.error("stale in webapp/: " + stale.join(", ") + ". Run: node telegram-bot/webapp/build.mjs");
    process.exit(1);
  }
  SHARED.forEach((entry) => {
    copyFileSync(entry.source, entry.copy);
    console.log("copied src/" + entry.name + " to webapp/" + entry.name);
  });
}
