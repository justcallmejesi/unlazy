// Environment configuration. Zero dependencies. Node 16+.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTimeOfDay, parseUtcOffset } from "./reminders.mjs";

const BOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_SHAPE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export const DEFAULT_CRISIS_CONTACT = [
  "Куда можно обратиться:",
  "• Единый номер экстренных служб: 112",
  "• Детский телефон доверия для детей, подростков и родителей: 8-800-2000-122",
  "• Линии доверия других стран: https://findahelpline.com",
].join("\n");

// Minimal KEY=VALUE reader for a local .env file. Existing environment
// variables always win, and nothing is executed or expanded.
export function parseEnvFile(text) {
  const values = {};
  String(text).split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/.exec(trimmed);
    if (!match) return;
    let value = match[2].trim();
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    values[match[1]] = value;
  });
  return values;
}

export function loadEnvFile(path, env = process.env) {
  if (!existsSync(path)) return false;
  const values = parseEnvFile(readFileSync(path, "utf8"));
  Object.keys(values).forEach((key) => {
    if (env[key] === undefined) env[key] = values[key];
  });
  return true;
}

function positiveNumber(raw, fallback, label) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(label + " must be a positive number");
  return value;
}

export function loadConfig(env = process.env, options = {}) {
  if (options.envFile !== false) loadEnvFile(options.envFile || join(BOT_DIR, ".env"), env);

  const token = String(env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!options.allowMissingToken && !token) {
    throw new Error("BOT_TOKEN is not set. Create telegram-bot/.env from .env.example or export BOT_TOKEN.");
  }
  if (token && !TOKEN_SHAPE.test(token)) {
    throw new Error("BOT_TOKEN does not look like a Telegram token (digits, a colon, then the secret).");
  }

  const time = String(env.REMINDER_TIME || "10:00").trim();
  if (!parseTimeOfDay(time)) throw new Error("REMINDER_TIME must be ЧЧ:ММ, for example 10:00");
  const rawOffset = String(env.REMINDER_UTC_OFFSET === undefined ? "+3" : env.REMINDER_UTC_OFFSET).trim();
  const offsetMinutes = parseUtcOffset(rawOffset);
  if (offsetMinutes === null) throw new Error("REMINDER_UTC_OFFSET must be an offset such as +3 or -05:30");

  const memoryOnly = /^(1|true|yes)$/i.test(String(env.MEMORY_ONLY || ""));
  const dataFile = memoryOnly
    ? null
    : resolve(String(env.DATA_FILE || join(BOT_DIR, ".data", "results.json")));

  return {
    token,
    apiBase: String(env.API_BASE || "https://api.telegram.org").replace(/\/+$/, ""),
    dataFile,
    memoryOnly,
    botDir: BOT_DIR,
    pollTimeoutSeconds: positiveNumber(env.POLL_TIMEOUT_SECONDS, 50, "POLL_TIMEOUT_SECONDS"),
    tickSeconds: positiveNumber(env.TICK_SECONDS, 60, "TICK_SECONDS"),
    sessionIdleTimeoutMs: positiveNumber(env.SESSION_IDLE_MINUTES, 60, "SESSION_IDLE_MINUTES") * 60 * 1000,
    crisisContact: String(env.CRISIS_CONTACT || DEFAULT_CRISIS_CONTACT),
    reminder: {
      time,
      offsetMinutes,
      graceMs: positiveNumber(env.REMINDER_GRACE_HOURS, 12, "REMINDER_GRACE_HOURS") * 60 * 60 * 1000,
    },
  };
}
