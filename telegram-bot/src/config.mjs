// Environment configuration. Zero dependencies. Node 16+.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTimeOfDay, parseUtcOffset, zoneOffsetMinutes } from "./reminders.mjs";

const BOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_SHAPE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

// Ukrainian services. Verified against the operators' own pages; see the
// sources listed in telegram-bot/README.md. Override with CRISIS_CONTACT for
// another country.
export const DEFAULT_CONTACT_USERNAME = "justajsi";
export const DEFAULT_CONTACT_NAME = "Олексій";
export const DEFAULT_CONTACT_ROLE = "психолог";

export const DEFAULT_CRISIS_CONTACT = [
  "Куди можна звернутися:",
  "• Екстрена допомога: 103 або 112",
  "• LifeLine Ukraine, лінія запобігання самогубствам: 7333, безкоштовно, круглодобово",
  "• Національна дитяча гаряча лінія: 116 111 з мобільного або 0 800 500 225",
  "• Служби підтримки і техніки самодопомоги: https://howareu.com",
  "• Лінії довіри інших країн: https://findahelpline.com",
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

function positiveInteger(raw, fallback, label) {
  const value = positiveNumber(raw, fallback, label);
  if (!Number.isInteger(value)) throw new Error(label + " must be a whole number");
  return value;
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

  const time = String(env.REMINDER_TIME || "19:00").trim();
  if (!parseTimeOfDay(time)) throw new Error("REMINDER_TIME must be HH:MM, for example 19:00");

  const rawWeekday = String(env.REMINDER_WEEKDAY === undefined ? "1" : env.REMINDER_WEEKDAY).trim();
  const weekday = Number(rawWeekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error("REMINDER_WEEKDAY must be 0 for Sunday through 6 for Saturday, default 1 for Monday");
  }

  // The zone carries the seasonal rule, so the local send hour survives the
  // March and October transitions without anyone editing anything.
  const zone = String(env.REMINDER_ZONE || "Europe/Kyiv").trim();
  if (zone && zoneOffsetMinutes(zone, Date.now()) === null) {
    throw new Error("REMINDER_ZONE " + zone + " is unknown to this runtime. Use REMINDER_UTC_OFFSET for a fixed offset.");
  }

  // An explicit offset overrides the zone and then follows no seasonal rule,
  // which is occasionally what an operator wants.
  let offsetMinutes = null;
  if (env.REMINDER_UTC_OFFSET !== undefined && String(env.REMINDER_UTC_OFFSET).trim() !== "") {
    offsetMinutes = parseUtcOffset(String(env.REMINDER_UTC_OFFSET).trim());
    if (offsetMinutes === null) {
      throw new Error("REMINDER_UTC_OFFSET must be an offset such as +2 or -05:30, or empty to use REMINDER_ZONE");
    }
  }

  // Telegram only opens a Mini App over https, so a wrong scheme is rejected
  // here instead of failing silently inside the client.
  const webappUrl = String(env.WEBAPP_URL || "").trim();
  if (webappUrl && !/^https:\/\/[^\s]+$/.test(webappUrl)) {
    throw new Error("WEBAPP_URL must be an https URL, for example https://example.pages.dev/");
  }

  // The owner's account, so the offer works without extra configuration.
  // CONTACT_USERNAME overrides it; an empty value switches the offer off.
  const contactUsername = String(
    env.CONTACT_USERNAME === undefined ? DEFAULT_CONTACT_USERNAME : env.CONTACT_USERNAME,
  ).trim().replace(/^@/, "");
  if (contactUsername && !/^[A-Za-z0-9_]{4,32}$/.test(contactUsername)) {
    throw new Error("CONTACT_USERNAME must be a Telegram username: 4 to 32 letters, digits or underscores");
  }

  const memoryOnly = /^(1|true|yes)$/i.test(String(env.MEMORY_ONLY || ""));
  const dataFile = memoryOnly
    ? null
    : resolve(String(env.DATA_FILE || join(BOT_DIR, ".data", "results.json")));

  return {
    token,
    apiBase: String(env.API_BASE || "https://api.telegram.org").replace(/\/+$/, ""),
    webappUrl: webappUrl || null,
    dataFile,
    memoryOnly,
    botDir: BOT_DIR,
    pollTimeoutSeconds: positiveNumber(env.POLL_TIMEOUT_SECONDS, 50, "POLL_TIMEOUT_SECONDS"),
    tickSeconds: positiveNumber(env.TICK_SECONDS, 60, "TICK_SECONDS"),
    sessionIdleTimeoutMs: positiveNumber(env.SESSION_IDLE_MINUTES, 60, "SESSION_IDLE_MINUTES") * 60 * 1000,
    crisisContact: String(env.CRISIS_CONTACT || DEFAULT_CRISIS_CONTACT),
    // Where to point someone whose score is above the cutoff. Empty username
    // switches the whole offer off.
    contact: {
      username: contactUsername,
      // Both fall back to the owner's details and both accept an explicit
      // empty value, which drops that part of the wording.
      name: String(env.CONTACT_NAME === undefined ? DEFAULT_CONTACT_NAME : env.CONTACT_NAME).trim(),
      role: String(env.CONTACT_ROLE === undefined ? DEFAULT_CONTACT_ROLE : env.CONTACT_ROLE).trim(),
    },
    price: {
      // Stars, not a minor currency unit. 100 Stars is roughly 100 UAH for the
      // buyer; what reaches the operator is less, see the README.
      stars: positiveInteger(env.PRICE_STARS, 100, "PRICE_STARS"),
      trialDays: positiveInteger(env.TRIAL_DAYS, 14, "TRIAL_DAYS"),
      title: String(env.PRICE_TITLE || "Повний доступ"),
      description: String(env.PRICE_DESCRIPTION ||
        "Шкали сну і стресу, повна історія та статистика. Одноразово, без підписки."),
    },
    reminder: {
      time,
      weekday,
      // Exactly one of these two is set: an explicit offset wins, otherwise
      // the zone resolves the offset per instant.
      zone: offsetMinutes === null ? zone : null,
      offsetMinutes,
      graceMs: positiveNumber(env.REMINDER_GRACE_HOURS, 12, "REMINDER_GRACE_HOURS") * 60 * 60 * 1000,
    },
  };
}
