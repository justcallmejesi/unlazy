#!/usr/bin/env node
// GAD-7 and PHQ-9 screening bot for Telegram, with in-memory results and a
// weekly reminder, Monday 19:00 Europe/Kyiv by default. Zero dependencies.
// Node 16+.
//
//   node telegram-bot/bot.mjs           long-poll and serve
//   node telegram-bot/bot.mjs --demo    run a scripted flow locally, no token
//   node telegram-bot/bot.mjs --help
//
// Long polling needs no public URL or TLS certificate, so the bot runs from a
// laptop, a container, or a small VM without a reverse proxy.

import { pathToFileURL } from "node:url";
import { loadConfig } from "./src/config.mjs";
import { entitlement } from "./src/billing.mjs";
import { TelegramClient, TelegramError } from "./src/telegram.mjs";
import { Store } from "./src/store.mjs";
import { SessionManager } from "./src/session.mjs";
import { createRouter } from "./src/router.mjs";
import { COMMANDS, weeklyReminder } from "./src/texts.mjs";
import {
  dueReminders, formatLocalDateTime, lastDueBefore, nextDueAfter, offsetAt, resolveSchedule,
} from "./src/reminders.mjs";

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
    this.sweeping = false;
    this.tickTimer = null;
  }

  // An action may carry `then`: a function of the call's result that returns
  // follow-up actions. createInvoiceLink needs it, since the link it returns
  // has to be put into a message; the router itself never waits on I/O.
  //
  // One batch can address several chats: a result also alerts the client's
  // specialists, a deletion tells each of them. A 403 skips the rest of that
  // one chat's actions and leaves everyone else's alone.
  async runActions(actions, blocked = new Set()) {
    for (const action of actions) {
      const chatId = action.payload && action.payload.chat_id;
      if (chatId !== undefined && blocked.has(String(chatId))) continue;
      try {
        const result = await this.client.call(action.method, action.payload);
        if (typeof action.then === "function") {
          const next = action.then(result);
          if (Array.isArray(next) && next.length) await this.runActions(next, blocked);
        }
      } catch (error) {
        const detail = error instanceof TelegramError ? error.message : this.client.redact(String(error && error.message));
        logError("action " + action.method + " failed: " + detail);
        if (error instanceof TelegramError && error.status === 403 && chatId !== undefined) {
          // The user blocked the bot or deleted the chat. Stop reminding them,
          // without recreating a record that /delete has just removed.
          blocked.add(String(chatId));
          if (this.store.hasUser(chatId)) {
            this.store.updateUser(chatId, { remindersEnabled: false });
            log("reminders disabled for chat " + chatId + " after 403");
          }
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
    // Telegram cancels a payment whose pre-checkout query waits more than ten
    // seconds, and the sends of a busy batch, retries included, can take longer
    // than that. So those answers go out first. The offset still advances in
    // order: a crash in between costs a second answer to one query, never a
    // lost message.
    const answered = new Set();
    for (const update of updates) {
      if (!update || !update.pre_checkout_query) continue;
      answered.add(update);
      await this.processUpdate(update);
    }
    for (const update of updates) {
      this.store.setOffset(Number(update.update_id) + 1);
      if (!answered.has(update)) await this.processUpdate(update);
    }
    return updates.length;
  }

  async processUpdate(update) {
    let actions = [];
    try {
      actions = this.router.handleUpdate(update);
    } catch (error) {
      logError("router failed on update " + update.update_id + ": " + String(error && error.message));
      return;
    }
    await this.runActions(actions);
  }

  // One reminder sweep. Returns the chat ids that were reminded. A sweep slower
  // than the tick (retries, a rate limit) must not overlap the next one: both
  // would read the same lastRemindedAt and remind the same chats twice.
  async sweepReminders(nowMs = Date.now()) {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      return await this.sweepOnce(nowMs);
    } finally {
      this.sweeping = false;
    }
  }

  async sweepOnce(nowMs) {
    const due = dueReminders({
      // The weekly reminder is part of the paid access, so a lapsed chat is
      // filtered out before any slot is computed for it.
      users: this.store.allUsers().filter((user) => entitlement(user, nowMs).active),
      nowMs,
      defaults: this.config.reminder,
      graceMs: this.config.reminder.graceMs,
    });
    const reminded = [];
    for (const entry of due) {
      const actions = this.router.reminderActions(entry.chatId,
        weeklyReminder(this.store, entry.chatId, entry.schedule));
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
  const config = loadConfig({ MEMORY_ONLY: "1" }, { allowMissingToken: true, envFile: false });
  const { store, sessions, router } = buildBot(config);
  const chat = { id: 4242, type: "private" };
  const from = { id: 4242, first_name: "Демо" };
  const script = ["/start", "/gad7", "2", "3", "1", "2", "1", "0", "2"]
    .concat(["Тиждень був напружений: багато роботи і мало сну, але допомагали прогулянки"])
    .concat(["/phq9", "1", "2", "1", "3", "0", "1", "2", "0", "1", "2"])
    .concat(["Ближче до вихідних стало легше"])
    .concat(["/last", "/results", "/remind 20:30", "/remind", "/tz +5", "/tz auto"]);

  script.forEach((text) => {
    console.log("\n>>> " + text);
    router.handleUpdate({ update_id: 1, message: { message_id: 1, chat, from, text } }).forEach((action) => {
      const payload = action.payload || {};
      if (payload.text) console.log(String(payload.text).replace(/<\/?[a-z]+>/g, ""));
    });
  });

  const schedule = resolveSchedule(store.user(chat.id), config.reminder);
  // Both sides of a transition, to show the local hour holding steady.
  [["summer", "2026-07-01T12:00:00Z"], ["winter", "2026-12-01T12:00:00Z"]].forEach(([label, iso]) => {
    const nowMs = Date.parse(iso);
    const due = nextDueAfter(nowMs, schedule);
    console.log("\n>>> next reminder in " + label + ": " +
      formatLocalDateTime(due, offsetAt(schedule, due)) +
      " local, UTC offset " + offsetAt(schedule, due) + " minutes");
  });
  const slot = lastDueBefore(Date.parse("2026-09-16T12:00:00Z"), schedule);
  const due = dueReminders({
    users: store.allUsers(),
    nowMs: slot + 60000,
    defaults: config.reminder,
    graceMs: config.reminder.graceMs,
  });
  console.log(">>> due one minute after the Monday slot: " + JSON.stringify(due.map((entry) => entry.chatId)));
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
  // Invite links for specialists point at t.me/<this bot>.
  config.botUsername = me && me.username ? String(me.username) : null;
  try {
    await client.setMyCommands(COMMANDS
      .filter((entry) => entry.command !== "app" || config.webappUrl)
      .map((entry) => ({ command: entry.command, description: entry.description })));
  } catch (error) {
    logError("setMyCommands failed: " + client.redact(String(error && error.message)));
  }
  if (config.webappUrl) {
    // The button beside the input field opens the same page. It cannot send
    // data back, so the keyboard button remains the one that submits.
    try {
      await client.call("setChatMenuButton", {
        menu_button: { type: "web_app", text: "Застосунок", web_app: { url: config.webappUrl } },
      });
      log("Mini App enabled: " + config.webappUrl);
    } catch (error) {
      logError("setChatMenuButton failed: " + client.redact(String(error && error.message)));
    }
  } else {
    log("WEBAPP_URL is not set, running the chat-only flow");
  }

  const runtime = new BotRuntime({ client, store, sessions, router, config });
  const defaults = resolveSchedule(null, config.reminder);
  const nextDue = nextDueAfter(Date.now(), defaults);
  log("weekly reminder: weekday " + defaults.weekday + " at " + config.reminder.time +
    " " + (defaults.zone || "UTC offset " + defaults.offsetMinutes) +
    ", next " + formatLocalDateTime(nextDue, offsetAt(defaults, nextDue)));
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
