#!/usr/bin/env node
// GAD-7 and PHQ-9 screening bot for Telegram, with in-memory results and a
// weekly Wednesday reminder. Zero dependencies. Node 16+.
//
//   node telegram-bot/bot.mjs           long-poll and serve
//   node telegram-bot/bot.mjs --demo    run a scripted flow locally, no token
//   node telegram-bot/bot.mjs --help
//
// Long polling needs no public URL or TLS certificate, so the bot runs from a
// laptop, a container, or a small VM without a reverse proxy.

import { pathToFileURL } from "node:url";
import { loadConfig } from "./src/config.mjs";
import { TelegramClient, TelegramError } from "./src/telegram.mjs";
import { Store } from "./src/store.mjs";
import { SessionManager } from "./src/session.mjs";
import { createRouter } from "./src/router.mjs";
import { COMMANDS, weeklyReminder } from "./src/texts.mjs";
import { dueReminders, formatLocalDateTime, nextDueAfter, resolveSchedule } from "./src/reminders.mjs";

const HELP = `usage: bot.mjs [--demo] [--help]

  (no options)  load configuration, verify the token, and long-poll for updates
  --demo        print a scripted GAD-7 and PHQ-9 conversation without a token
  --help        show this message

environment: see telegram-bot/.env.example`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const stamp = () => new Date().toISOString();

function log(message) {
  console.log(stamp() + " " + message);
}

function logError(message) {
  console.error(stamp() + " " + message);
}

export class BotRuntime {
  constructor(parts) {
    this.client = parts.client;
    this.store = parts.store;
    this.sessions = parts.sessions;
    this.router = parts.router;
    this.config = parts.config;
    this.running = false;
    this.tickTimer = null;
  }

  async runActions(actions) {
    for (const action of actions) {
      try {
        await this.client.call(action.method, action.payload);
      } catch (error) {
        const detail = error instanceof TelegramError ? error.message : this.client.redact(String(error && error.message));
        logError("action " + action.method + " failed: " + detail);
        if (error instanceof TelegramError && error.status === 403) {
          // The user blocked the bot or deleted the chat. Stop reminding them.
          const chatId = action.payload && action.payload.chat_id;
          if (chatId !== undefined) {
            this.store.updateUser(chatId, { remindersEnabled: false });
            log("reminders disabled for chat " + chatId + " after 403");
          }
          break;
        }
      }
    }
  }

  async pollOnce() {
    const updates = await this.client.getUpdates({
      offset: this.store.offset || undefined,
      timeoutSeconds: this.config.pollTimeoutSeconds,
    });
    if (!Array.isArray(updates)) return 0;
    for (const update of updates) {
      this.store.setOffset(Number(update.update_id) + 1);
      let actions = [];
      try {
        actions = this.router.handleUpdate(update);
      } catch (error) {
        logError("router failed on update " + update.update_id + ": " + String(error && error.message));
        continue;
      }
      await this.runActions(actions);
    }
    return updates.length;
  }

  // One reminder sweep. Returns the chat ids that were reminded.
  async sweepReminders(nowMs = Date.now()) {
    const due = dueReminders({
      users: this.store.allUsers(),
      nowMs,
      defaults: this.config.reminder,
      graceMs: this.config.reminder.graceMs,
    });
    const reminded = [];
    for (const entry of due) {
      const actions = this.router.reminderActions(entry.chatId, weeklyReminder(this.store, entry.chatId));
      try {
        for (const action of actions) await this.client.call(action.method, action.payload);
        this.store.updateUser(entry.chatId, { lastRemindedAt: entry.dueAt });
        reminded.push(entry.chatId);
      } catch (error) {
        if (error instanceof TelegramError && error.status === 403) {
          this.store.updateUser(entry.chatId, { remindersEnabled: false, lastRemindedAt: entry.dueAt });
          log("reminders disabled for chat " + entry.chatId + " after 403");
          continue;
        }
        logError("reminder for chat " + entry.chatId + " failed: " +
          this.client.redact(String(error && error.message)));
      }
    }
    if (reminded.length) log("weekly reminder sent to " + reminded.length + " chat(s)");
    return reminded;
  }

  startTicker() {
    const intervalMs = this.config.tickSeconds * 1000;
    const runTick = () => {
      this.sweepReminders().catch((error) => logError("reminder sweep failed: " + String(error && error.message)));
    };
    this.tickTimer = setInterval(runTick, intervalMs);
    runTick();
  }

  async loop() {
    this.running = true;
    let backoffMs = 1000;
    while (this.running) {
      try {
        await this.pollOnce();
        backoffMs = 1000;
      } catch (error) {
        if (error instanceof TelegramError && error.fatal) {
          logError("fatal Telegram error: " + error.message);
          this.running = false;
          throw error;
        }
        logError("poll failed, retrying in " + backoffMs + "ms: " +
          this.client.redact(String(error && error.message)));
        await sleep(backoffMs);
        backoffMs = Math.min(60000, backoffMs * 2);
      }
    }
  }

  stop() {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}

export function buildBot(config) {
  const store = new Store({
    file: config.dataFile,
    onError: (error) => logError("snapshot write failed: " + String(error && error.message)),
    onWarning: (message) => logError("storage warning: " + message),
  });
  const sessions = new SessionManager({ idleTimeoutMs: config.sessionIdleTimeoutMs });
  const router = createRouter({ store, sessions, config });
  return { store, sessions, router };
}

function demo() {
  const config = loadConfig({ MEMORY_ONLY: "1", REMINDER_TIME: "10:00", REMINDER_UTC_OFFSET: "+3" }, {
    allowMissingToken: true,
    envFile: false,
  });
  const { store, sessions, router } = buildBot(config);
  const chat = { id: 4242, type: "private" };
  const from = { id: 4242, first_name: "Демо" };
  const script = ["/start", "/gad7", "2", "3", "1", "2", "1", "0", "2"]
    .concat(["Тиждень був напружений: багато роботи і мало сну, але допомагали прогулянки"])
    .concat(["/phq9", "1", "2", "1", "3", "0", "1", "2", "0", "1", "2"])
    .concat(["Ближче до вихідних стало легше"])
    .concat(["/last", "/results", "/remind 09:30", "/tz +3", "/remind"]);

  script.forEach((text) => {
    console.log("\n>>> " + text);
    router.handleUpdate({ update_id: 1, message: { message_id: 1, chat, from, text } }).forEach((action) => {
      const payload = action.payload || {};
      if (payload.text) console.log(String(payload.text).replace(/<\/?[a-z]+>/g, ""));
    });
  });

  const nowMs = Date.parse("2026-09-16T12:00:00Z");
  const schedule = resolveSchedule(store.user(chat.id), config.reminder);
  console.log("\n>>> next Wednesday reminder: " +
    formatLocalDateTime(nextDueAfter(nowMs, schedule), schedule.offsetMinutes) +
    " (" + schedule.offsetMinutes + " minutes from UTC)");
  const due = dueReminders({
    users: store.allUsers(),
    nowMs: Date.parse("2026-09-16T06:30:00Z"),
    defaults: config.reminder,
    graceMs: config.reminder.graceMs,
  });
  console.log(">>> due at Wednesday 09:30 MSK: " + JSON.stringify(due.map((entry) => entry.chatId)));
  console.log(">>> stored results: " + JSON.stringify(store.history(chat.id).map((entry) =>
    entry.instrument + "=" + entry.score)));
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !["--demo", "--help", "-h"].includes(arg));
  if (unknown.length) {
    logError("unknown option " + unknown[0]);
    console.error(HELP);
    process.exit(2);
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (args.includes("--demo")) {
    demo();
    return;
  }

  const config = loadConfig();
  const { store, sessions, router } = buildBot(config);
  const loaded = store.load();
  log(config.memoryOnly
    ? "memory-only mode, results are not written to disk"
    : "snapshot " + config.dataFile + " " + (loaded.loaded ? "loaded, users: " + loaded.users : "(" + loaded.reason + ")"));

  const client = new TelegramClient({ token: config.token, apiBase: config.apiBase, log });
  const me = await client.getMe();
  log("authorized as @" + (me && me.username));
  try {
    await client.setMyCommands(COMMANDS.map((entry) => ({ command: entry.command, description: entry.description })));
  } catch (error) {
    logError("setMyCommands failed: " + client.redact(String(error && error.message)));
  }

  const runtime = new BotRuntime({ client, store, sessions, router, config });
  const defaults = resolveSchedule(null, config.reminder);
  log("weekly reminder: Wednesday " + config.reminder.time + " default, next " +
    formatLocalDateTime(nextDueAfter(Date.now(), defaults), defaults.offsetMinutes));
  runtime.startTicker();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("received " + signal + ", flushing and exiting");
    runtime.stop();
    try {
      store.flush();
    } catch (error) {
      logError("final flush failed: " + String(error && error.message));
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log("polling for updates");
  await runtime.loop();
}

// Importing this file for tests must not start the bot.
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    logError("bot stopped: " + String(error && error.message));
    process.exit(1);
  });
}
