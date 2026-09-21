#!/usr/bin/env node
// run-tests.mjs : behavioural tests for the GAD-7 and PHQ-9 Telegram bot.
// Zero dependencies, cross-platform, no network beyond a local loopback server.
//
//   node telegram-bot/tests/run-tests.mjs            run all
//   node telegram-bot/tests/run-tests.mjs reminder   run tests whose name contains "reminder"
//
// Prints "N/N passed" on success, which is the string CI matches on.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { GAD7, PHQ9, buildResult, scoreAnswers, severityOf, riskFlagged } from "../src/instruments.mjs";
import { Store, MAX_NOTE_LENGTH, MAX_RESULTS_PER_USER } from "../src/store.mjs";
import { SessionManager } from "../src/session.mjs";
import {
  DAY_MS, MONDAY, WEDNESDAY, WEEK_MS, dueReminders, formatLocalDateTime, formatUtcOffset,
  isEuSummerTime, lastDueBefore, lastSundayUtc, nextDueAfter, offsetAt, parseTimeOfDay,
  parseUtcOffset, resolveSchedule, zoneOffsetMinutes,
} from "../src/reminders.mjs";
import { createRouter, parseAnswerCallback, parseCommand } from "../src/router.mjs";
import { TelegramClient, TelegramError, escapeHtml } from "../src/telegram.mjs";
import { DEFAULT_CRISIS_CONTACT, loadConfig, parseEnvFile } from "../src/config.mjs";
import { BotRuntime, buildBot } from "../bot.mjs";
import { MAX_PAYLOAD_BYTES, parseWebAppPayload } from "../src/webapp.mjs";
import { COPY, SOURCE, isCurrent } from "../webapp/build.mjs";
import { historyMessage, lastMessage, weeklyReminder } from "../src/texts.mjs";

const filter = process.argv[2] || "";
const DIR = mkdtempSync(join(tmpdir(), "gad7-phq9-bot-test-"));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const FAKE_TOKEN = "123456789:AAFakeTokenForTestsOnly_0123456789ab";
const WED_NOON_UTC = Date.parse("2026-09-16T12:00:00Z"); // Wednesday
// Monday 19:00 Kyiv is 16:00 UTC. Five minutes past the slot, inside the grace
// window, is when a sweep is supposed to fire.
const MONDAY_SLOT_UTC = Date.parse("2026-09-14T16:00:00Z");
const JUST_AFTER_SLOT = MONDAY_SLOT_UTC + 5 * 60 * 1000;

function fixtureConfig(overrides = {}) {
  return Object.assign({
    crisisContact: DEFAULT_CRISIS_CONTACT,
    reminder: { time: "19:00", weekday: 1, zone: null, offsetMinutes: 180, graceMs: 12 * 60 * 60 * 1000 },
    pollTimeoutSeconds: 1,
    tickSeconds: 60,
    sessionIdleTimeoutMs: 60 * 60 * 1000,
    memoryOnly: true,
    dataFile: null,
    webappUrl: null,
  }, overrides);
}

// A router wired to in-memory parts and a clock the test controls.
function harness(overrides = {}) {
  const config = fixtureConfig(overrides.config);
  const store = new Store({ file: null });
  const sessions = new SessionManager({ idleTimeoutMs: config.sessionIdleTimeoutMs });
  const clock = { now: overrides.now === undefined ? WED_NOON_UTC : overrides.now };
  const router = createRouter({ store, sessions, config, now: () => clock.now });
  const chat = { id: 777, type: "private" };
  const say = (text) => router.handleUpdate({
    update_id: 1,
    message: { message_id: 10, chat, from: { id: 777, first_name: "Тест" }, text },
  });
  const tap = (data, messageId = 11) => router.handleUpdate({
    update_id: 2,
    callback_query: { id: "cb1", data, message: { message_id: messageId, chat } },
  });
  return { config, store, sessions, router, clock, chat, say, tap };
}

const textsOf = (actions) => actions
  .filter((action) => action.payload && typeof action.payload.text === "string")
  .map((action) => action.payload.text);
const lastText = (actions) => textsOf(actions)[textsOf(actions).length - 1];
// A finished run sends the score and then the open question, so a test that
// means the score says so.
const scoreText = (actions) => textsOf(actions).find((text) => text.indexOf("Бали:") !== -1);
const methodsOf = (actions) => actions.map((action) => action.method);

// Answer every question of an instrument through the inline keyboard.
function completeViaKeyboard(h, instrument, answers) {
  const started = h.say(instrument.command);
  let actions = started;
  answers.forEach((value, index) => {
    const session = h.sessions.get(h.chat.id, h.clock.now);
    const data = ["a", session ? session.id : "x", index, value].join("|");
    actions = h.tap(data);
  });
  return actions;
}

// --------------------------------------------------------------- instruments

test("instruments: GAD-7 has seven scored items and a 21 point maximum", () => {
  assert.equal(GAD7.items.length, 7);
  assert.equal(GAD7.items.filter((item) => item.scored).length, 7);
  assert.equal(scoreAnswers(GAD7, [3, 3, 3, 3, 3, 3, 3]), 21);
  assert.equal(scoreAnswers(GAD7, [0, 0, 0, 0, 0, 0, 0]), 0);
});

test("instruments: PHQ-9 scores nine items and asks an unscored tenth", () => {
  assert.equal(PHQ9.items.length, 10);
  assert.equal(PHQ9.items.filter((item) => item.scored).length, 9);
  // The impairment answer of 3 must not reach the total.
  assert.equal(scoreAnswers(PHQ9, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]), 27);
  assert.equal(scoreAnswers(PHQ9, [0, 0, 0, 0, 0, 0, 0, 0, 0, 3]), 0);
});

test("instruments: severity bands match the published boundaries", () => {
  const gad = [[0, "мінімальна"], [4, "мінімальна"], [5, "легка"], [9, "легка"],
    [10, "помірна"], [14, "помірна"], [15, "виражена"], [21, "виражена"]];
  gad.forEach(([score, expected]) => assert.match(severityOf(GAD7, score), new RegExp(expected)));
  const phq = [[0, "мінімальні"], [4, "мінімальні"], [5, "легкі"], [9, "легкі"],
    [10, "помірні прояви"], [14, "помірні прояви"], [15, "помірно тяжкі"],
    [19, "помірно тяжкі"], [20, "тяжкі"], [27, "тяжкі"]];
  phq.forEach(([score, expected]) => assert.match(severityOf(PHQ9, score), new RegExp(expected)));
});

test("instruments: scoring rejects a wrong answer count or an out-of-range value", () => {
  assert.throws(() => scoreAnswers(GAD7, [1, 1, 1]), /exactly 7 answers/);
  assert.throws(() => scoreAnswers(GAD7, [1, 1, 1, 1, 1, 1, 4]), /outside the option set/);
  assert.throws(() => scoreAnswers(GAD7, [1, 1, 1, 1, 1, 1, -1]), /outside the option set/);
});

test("instruments: PHQ-9 item nine above zero raises the risk flag", () => {
  assert.equal(riskFlagged(PHQ9, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), false);
  assert.equal(riskFlagged(PHQ9, [0, 0, 0, 0, 0, 0, 0, 0, 1, 0]), true);
  assert.equal(riskFlagged(GAD7, [3, 3, 3, 3, 3, 3, 3]), false);
});

test("instruments: buildResult records score, band, cutoff, risk, and impairment", () => {
  const result = buildResult(PHQ9, [2, 2, 2, 2, 2, 2, 2, 2, 1, 2], WED_NOON_UTC);
  assert.equal(result.instrument, "phq9");
  assert.equal(result.score, 17);
  assert.equal(result.maxScore, 27);
  assert.match(result.severity, /помірно тяжкі/);
  assert.equal(result.aboveCutoff, true);
  assert.equal(result.risk, true);
  assert.equal(result.impairment, 2);
  assert.equal(result.completedAt, "2026-09-16T12:00:00.000Z");
  const calm = buildResult(GAD7, [0, 1, 0, 1, 0, 0, 1], WED_NOON_UTC);
  assert.equal(calm.score, 3);
  assert.equal(calm.aboveCutoff, false);
  assert.equal(calm.risk, false);
  assert.equal(calm.impairment, null);
});

// --------------------------------------------------------------- store

test("store: results are held in memory, newest first, per instrument", () => {
  const store = new Store({ file: null });
  store.addResult(5, buildResult(GAD7, [1, 1, 1, 1, 1, 1, 1], WED_NOON_UTC));
  store.addResult(5, buildResult(PHQ9, [1, 1, 1, 1, 1, 1, 1, 1, 0, 1], WED_NOON_UTC + 1000));
  store.addResult(5, buildResult(GAD7, [2, 2, 2, 2, 2, 2, 2], WED_NOON_UTC + 2000));
  assert.equal(store.history(5).length, 3);
  assert.deepEqual(store.history(5, "gad7").map((entry) => entry.score), [14, 7]);
  assert.equal(store.lastResult(5, "gad7").score, 14);
  assert.equal(store.lastResult(5, "phq9").score, 8);
  assert.equal(store.lastResult(6, "gad7"), null);
  assert.deepEqual(store.history(7), []);
});

test("store: per-user history is capped without losing the newest entries", () => {
  const store = new Store({ file: null });
  for (let index = 0; index < MAX_RESULTS_PER_USER + 10; index++) {
    store.addResult(9, buildResult(GAD7, [0, 0, 0, 0, 0, 0, 0], WED_NOON_UTC + index));
  }
  const kept = store.history(9);
  assert.equal(kept.length, MAX_RESULTS_PER_USER);
  assert.equal(Date.parse(kept[0].completedAt), WED_NOON_UTC + MAX_RESULTS_PER_USER + 9);
});

test("store: snapshot round-trips users, results, settings, and the update offset", () => {
  const file = join(DIR, "snapshot.json");
  const first = new Store({ file, writeDelayMs: 0 });
  first.updateUser(11, { remindersEnabled: false, reminderTime: "08:15", tzOffsetMinutes: -300 });
  first.addResult(11, buildResult(GAD7, [1, 2, 1, 2, 1, 2, 1], WED_NOON_UTC));
  first.setOffset(4242);
  assert.equal(first.flush(), true);
  assert.equal(first.flush(), false, "a clean store must not rewrite the snapshot");

  const second = new Store({ file });
  const loaded = second.load();
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.users, 1);
  assert.equal(second.offset, 4242);
  const user = second.user(11);
  assert.equal(user.remindersEnabled, false);
  assert.equal(user.reminderTime, "08:15");
  assert.equal(user.tzOffsetMinutes, -300);
  assert.equal(user.results.length, 1);
  assert.equal(user.results[0].score, 10);
  assert.match(readFileSync(file, "utf8"), /^\{"version":1,/, "the snapshot is written compact");
});

test("store: the writer can never produce a snapshot the reader refuses", () => {
  const file = join(DIR, "ceiling.json");
  const seed = new Store({ file, writeDelayMs: 1e9 });
  seed.addResult(1, buildResult(GAD7, [1, 1, 1, 1, 1, 1, 1], WED_NOON_UTC));
  assert.equal(seed.flush(), true);
  const good = readFileSync(file, "utf8");

  // Same file, same ceiling: whatever the writer refuses, the reader refuses.
  const tight = new Store({ file, writeDelayMs: 1e9, maxSnapshotBytes: 64 });
  tight.addResult(2, buildResult(PHQ9, [1, 1, 1, 1, 1, 1, 1, 1, 0, 1], WED_NOON_UTC));
  assert.throws(() => tight.flush(), /over the 64 byte ceiling/);
  assert.throws(() => tight.flush(), /move storage to a database/);
  assert.equal(readFileSync(file, "utf8"), good, "a refused flush leaves the last good snapshot intact");
  assert.deepEqual(readdirSync(DIR).filter((name) => name.startsWith("ceiling.json.tmp")), [],
    "a refused flush leaves no temporary file behind");
  assert.throws(() => new Store({ file, maxSnapshotBytes: 64 }).load(), /over the 64 byte ceiling/);
  assert.equal(new Store({ file }).load().loaded, true, "the same file loads under the real ceiling");
});

test("store: crossing the soft size threshold warns once, not every flush", () => {
  const file = join(DIR, "warn.json");
  const warnings = [];
  const store = new Store({
    file,
    writeDelayMs: 1e9,
    warnSnapshotBytes: 64,
    onWarning: (message) => warnings.push(message),
  });
  store.addResult(1, buildResult(GAD7, [1, 1, 1, 1, 1, 1, 1], WED_NOON_UTC));
  assert.equal(store.flush(), true);
  store.addResult(1, buildResult(GAD7, [2, 2, 2, 2, 2, 2, 2], WED_NOON_UTC));
  assert.equal(store.flush(), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /blocks the event loop/);
});

test("store: a malformed snapshot user is normalized instead of trusted", () => {
  const file = join(DIR, "malformed.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    offset: "not-a-number",
    users: {
      "12": {
        remindersEnabled: "yes",
        reminderTime: 7,
        tzOffsetMinutes: 1.5,
        lastRemindedAt: "x",
        results: [1, null, { instrument: "gad7", score: 3 }],
      },
      bad: {},
    },
  }));
  const store = new Store({ file });
  const loaded = store.load();
  assert.equal(loaded.loaded, true);
  assert.equal(store.offset, 0);
  const user = store.user(12);
  assert.equal(user.remindersEnabled, true, "only an explicit false disables reminders");
  assert.equal(user.reminderTime, null);
  assert.equal(user.tzOffsetMinutes, null);
  assert.equal(user.lastRemindedAt, 0);
  assert.deepEqual(user.results.map((entry) => entry.instrument), ["gad7"]);
  assert.equal(store.hasUser("bad"), false);
});

test("store: an absent snapshot is a fresh start and a corrupt one fails closed", () => {
  const missing = new Store({ file: join(DIR, "nothing-here.json") });
  assert.deepEqual(missing.load(), { loaded: false, reason: "no snapshot yet" });
  assert.deepEqual(new Store({ file: null }).load(), { loaded: false, reason: "memory-only" });
  const corrupt = join(DIR, "corrupt.json");
  writeFileSync(corrupt, "{ not json");
  assert.throws(() => new Store({ file: corrupt }).load(), /JSON/);
  const wrongRoot = join(DIR, "root.json");
  writeFileSync(wrongRoot, "[]");
  assert.throws(() => new Store({ file: wrongRoot }).load(), /root must be an object/);
});

test("store: a stored result with derived fields missing still renders", () => {
  const file = join(DIR, "sparse.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    offset: 3,
    users: {
      "13": {
        results: [
          { instrument: "gad7", score: 12, completedAt: "2026-09-09T07:00:00.000Z" },
          { instrument: "phq9", score: "oops" },
        ],
      },
    },
  }));
  const store = new Store({ file });
  store.load();
  assert.deepEqual(store.history(13).map((entry) => entry.instrument), ["gad7"]);
  const schedule = { weekday: MONDAY, hour: 19, minute: 0, offsetMinutes: 180 };
  const text = historyMessage(store, 13, schedule);
  assert.match(text, /<b>12<\/b>\/21 помірна тривога/);
  assert.doesNotMatch(text, /undefined/);
  assert.doesNotMatch(lastMessage(store, 13, schedule), /undefined/);
});

test("store: the update offset only moves forward and forget removes a user", () => {
  const store = new Store({ file: null });
  store.setOffset(10);
  store.setOffset(5);
  assert.equal(store.offset, 10);
  store.addResult(3, buildResult(GAD7, [0, 0, 0, 0, 0, 0, 0], WED_NOON_UTC));
  assert.equal(store.forget(3), true);
  assert.equal(store.forget(3), false);
  assert.equal(store.hasUser(3), false);
});

// --------------------------------------------------------------- sessions

test("session: answers advance one item at a time and finish once", () => {
  const sessions = new SessionManager();
  const session = sessions.start(4, GAD7, 1000);
  assert.equal(session.total, 7);
  for (let index = 0; index < 6; index++) {
    const outcome = sessions.answer(4, 1, { sessionId: session.id, itemIndex: index }, 1000 + index);
    assert.equal(outcome.status, "recorded");
    assert.equal(outcome.done, false);
  }
  const final = sessions.answer(4, 2, { sessionId: session.id, itemIndex: 6 }, 2000);
  assert.equal(final.done, true);
  assert.deepEqual(final.session.answers, [1, 1, 1, 1, 1, 1, 2]);
  assert.equal(sessions.get(4), null, "a finished session is removed");
  assert.equal(sessions.answer(4, 1, null, 2001).status, "none");
});

test("session: a repeated tap on an answered question is stale, not a second answer", () => {
  const sessions = new SessionManager();
  const session = sessions.start(4, GAD7, 1000);
  assert.equal(sessions.answer(4, 3, { sessionId: session.id, itemIndex: 0 }, 1000).status, "recorded");
  const repeat = sessions.answer(4, 0, { sessionId: session.id, itemIndex: 0 }, 1001);
  assert.equal(repeat.status, "stale");
  assert.equal(sessions.answer(4, 0, { sessionId: "other", itemIndex: 1 }, 1002).status, "stale");
  assert.deepEqual(sessions.get(4).answers, [3]);
});

test("session: an idle session expires and a restart replaces it", () => {
  const sessions = new SessionManager({ idleTimeoutMs: 1000 });
  const first = sessions.start(4, GAD7, 0);
  assert.equal(sessions.get(4, 500).id, first.id);
  assert.equal(sessions.get(4, 2000), null);
  const second = sessions.start(4, PHQ9, 3000);
  assert.notEqual(second.id, first.id);
  assert.equal(sessions.size(), 1);
  assert.equal(sessions.cancel(4), true);
  assert.equal(sessions.cancel(4), false);
});

// --------------------------------------------------------------- reminders

test("reminder: the due moment is the most recent Wednesday at the local time", () => {
  const schedule = { weekday: 3, hour: 10, minute: 0, offsetMinutes: 180 };
  // Wednesday 12:00 UTC is 15:00 MSK, so 10:00 MSK today has passed.
  assert.equal(lastDueBefore(WED_NOON_UTC, schedule), Date.parse("2026-09-16T07:00:00Z"));
  // Wednesday 05:00 UTC is 08:00 MSK, so the slot is still the previous week.
  assert.equal(lastDueBefore(Date.parse("2026-09-16T05:00:00Z"), schedule),
    Date.parse("2026-09-09T07:00:00Z"));
  // Exactly on the slot counts as due.
  assert.equal(lastDueBefore(Date.parse("2026-09-16T07:00:00Z"), schedule),
    Date.parse("2026-09-16T07:00:00Z"));
  // Thursday and the following Tuesday both resolve back to Wednesday.
  assert.equal(lastDueBefore(Date.parse("2026-09-17T09:00:00Z"), schedule),
    Date.parse("2026-09-16T07:00:00Z"));
  assert.equal(lastDueBefore(Date.parse("2026-09-22T23:00:00Z"), schedule),
    Date.parse("2026-09-16T07:00:00Z"));
  assert.equal(nextDueAfter(WED_NOON_UTC, schedule), Date.parse("2026-09-23T07:00:00Z"));
});

test("reminder: local Wednesday is honoured across the UTC date boundary", () => {
  // 09:00 in UTC+13 on Wednesday is Tuesday 20:00 UTC.
  const east = { weekday: 3, hour: 9, minute: 0, offsetMinutes: 13 * 60 };
  assert.equal(lastDueBefore(Date.parse("2026-09-16T00:00:00Z"), east),
    Date.parse("2026-09-15T20:00:00Z"));
  // 22:00 in UTC-8 on Wednesday is Thursday 06:00 UTC.
  const west = { weekday: 3, hour: 22, minute: 0, offsetMinutes: -8 * 60 };
  assert.equal(lastDueBefore(Date.parse("2026-09-17T12:00:00Z"), west),
    Date.parse("2026-09-17T06:00:00Z"));
  assert.equal(lastDueBefore(Date.parse("2026-09-17T05:00:00Z"), west),
    Date.parse("2026-09-10T06:00:00Z"));
  assert.equal(nextDueAfter(Date.parse("2026-09-17T05:00:00Z"), west) -
    lastDueBefore(Date.parse("2026-09-17T05:00:00Z"), west), WEEK_MS);
});

test("reminder: due list skips disabled, already reminded, and long overdue chats", () => {
  const defaults = { time: "10:00", weekday: WEDNESDAY, offsetMinutes: 180 };
  const dueAt = Date.parse("2026-09-16T07:00:00Z");
  const users = [
    { chatId: 1, remindersEnabled: true, lastRemindedAt: 0 },
    { chatId: 2, remindersEnabled: false, lastRemindedAt: 0 },
    { chatId: 3, remindersEnabled: true, lastRemindedAt: dueAt },
    { chatId: 4, remindersEnabled: true, lastRemindedAt: dueAt - WEEK_MS },
    { chatId: 5, remindersEnabled: true, lastRemindedAt: 0, reminderTime: "23:59" },
  ];
  const due = dueReminders({ users, nowMs: WED_NOON_UTC, defaults, graceMs: 12 * 60 * 60 * 1000 });
  assert.deepEqual(due.map((entry) => entry.chatId), [1, 4]);
  assert.equal(due[0].dueAt, dueAt);

  // Outside the grace window the slot is skipped rather than fired late.
  const late = dueReminders({
    users: [users[0]],
    nowMs: dueAt + 13 * 60 * 60 * 1000,
    defaults,
    graceMs: 12 * 60 * 60 * 1000,
  });
  assert.deepEqual(late, []);
  // A per-user time is respected: 23:59 MSK Wednesday has not arrived yet.
  const evening = dueReminders({
    users: [users[4]],
    nowMs: Date.parse("2026-09-16T21:00:00Z"),
    defaults,
    graceMs: 12 * 60 * 60 * 1000,
  });
  assert.deepEqual(evening.map((entry) => entry.chatId), [5]);
});

test("reminder: per-user time and offset override the defaults", () => {
  const defaults = { time: "10:00", weekday: WEDNESDAY, offsetMinutes: 180 };
  assert.deepEqual(resolveSchedule(null, defaults), { weekday: 3, hour: 10, minute: 0, offsetMinutes: 180 });
  assert.deepEqual(resolveSchedule({ reminderTime: "07:45", tzOffsetMinutes: 0 }, defaults),
    { weekday: 3, hour: 7, minute: 45, offsetMinutes: 0 });
  assert.deepEqual(resolveSchedule({ reminderTime: "bad" }, defaults),
    { weekday: 3, hour: 10, minute: 0, offsetMinutes: 180 });
  // Monday 19:00 is the shipped default when nothing is configured.
  assert.deepEqual(resolveSchedule(null, { zone: "Europe/Kyiv" }),
    { weekday: MONDAY, hour: 19, minute: 0, zone: "Europe/Kyiv" });
  // A user offset replaces the zone, which is how /tz opts out of the rule.
  assert.deepEqual(resolveSchedule({ tzOffsetMinutes: -300 }, { zone: "Europe/Kyiv" }),
    { weekday: MONDAY, hour: 19, minute: 0, offsetMinutes: -300 });
});

test("reminder: the Kyiv zone switches at the exact transition instants", () => {
  const kyiv = (iso) => zoneOffsetMinutes("Europe/Kyiv", Date.parse(iso));
  assert.equal(kyiv("2026-01-15T12:00:00Z"), 120, "winter is UTC+2");
  assert.equal(kyiv("2026-07-15T12:00:00Z"), 180, "summer is UTC+3");
  // 01:00 UTC on the last Sunday of March and of October.
  assert.equal(kyiv("2026-03-29T00:59:00Z"), 120);
  assert.equal(kyiv("2026-03-29T01:00:00Z"), 180);
  assert.equal(kyiv("2026-10-25T00:59:00Z"), 180);
  assert.equal(kyiv("2026-10-25T01:00:00Z"), 120);
  assert.equal(zoneOffsetMinutes("Mars/Olympus", WED_NOON_UTC), null, "an unknown zone resolves to nothing");
});

test("reminder: the arithmetic EU rule matches the platform time-zone database", () => {
  // The rule is the fallback for a Node built without full ICU. Comparing it
  // against the database here keeps the two from disagreeing unnoticed.
  assert.equal(lastSundayUtc(2026, 2, 1), Date.parse("2026-03-29T01:00:00Z"));
  assert.equal(lastSundayUtc(2026, 9, 1), Date.parse("2026-10-25T01:00:00Z"));
  assert.equal(lastSundayUtc(2027, 2, 1), Date.parse("2027-03-28T01:00:00Z"));
  assert.equal(lastSundayUtc(2028, 9, 1), Date.parse("2028-10-29T01:00:00Z"));

  let checked = 0;
  for (let year = 2026; year <= 2029; year++) {
    for (let day = 0; day < 365; day += 1) {
      const ms = Date.UTC(year, 0, 1, 12) + day * DAY_MS;
      const fromDatabase = zoneOffsetMinutes("Europe/Kyiv", ms);
      if (fromDatabase === null) continue;
      const fromRule = isEuSummerTime(ms) ? 180 : 120;
      assert.equal(fromDatabase, fromRule, new Date(ms).toISOString());
      checked++;
    }
  }
  assert.ok(checked > 1400, "expected four years of daily samples, got " + checked);
});

test("reminder: a zoned slot keeps its local hour across both transitions", () => {
  const schedule = { weekday: MONDAY, hour: 19, minute: 0, zone: "Europe/Kyiv" };
  const localOf = (ms) => formatLocalDateTime(ms, offsetAt(schedule, ms));

  // Sunday morning right after the October switch to winter time.
  const afterOctober = Date.parse("2026-10-25T02:00:00Z");
  assert.equal(lastDueBefore(afterOctober, schedule), Date.parse("2026-10-19T16:00:00Z"));
  assert.equal(localOf(lastDueBefore(afterOctober, schedule)), "19.10.2026 19:00");
  assert.equal(nextDueAfter(afterOctober, schedule), Date.parse("2026-10-26T17:00:00Z"));
  assert.equal(localOf(nextDueAfter(afterOctober, schedule)), "26.10.2026 19:00");

  // And right after the March switch to summer time.
  const afterMarch = Date.parse("2026-03-29T02:00:00Z");
  assert.equal(lastDueBefore(afterMarch, schedule), Date.parse("2026-03-23T17:00:00Z"));
  assert.equal(localOf(lastDueBefore(afterMarch, schedule)), "23.03.2026 19:00");
  assert.equal(nextDueAfter(afterMarch, schedule), Date.parse("2026-03-30T16:00:00Z"));
  assert.equal(localOf(nextDueAfter(afterMarch, schedule)), "30.03.2026 19:00");

  // The UTC instant moves by an hour while the local hour never does.
  assert.notEqual(
    nextDueAfter(afterOctober, schedule) - lastDueBefore(afterOctober, schedule),
    WEEK_MS,
    "seven days of elapsed time would land on the wrong local hour",
  );

  // Every Monday of a year lands on 19:00 local, whatever the season.
  for (let week = 0; week < 52; week++) {
    const probe = Date.parse("2026-01-07T12:00:00Z") + week * WEEK_MS;
    const due = lastDueBefore(probe, schedule);
    assert.match(localOf(due), /\d{2}\.\d{2}\.\d{4} 19:00$/, new Date(probe).toISOString());
    assert.equal(new Date(due + offsetAt(schedule, due) * 60000).getUTCDay(), MONDAY);
  }
});

test("reminder: an explicit offset follows no seasonal rule", () => {
  const fixed = { weekday: MONDAY, hour: 19, minute: 0, offsetMinutes: 180 };
  assert.equal(offsetAt(fixed, Date.parse("2026-01-15T12:00:00Z")), 180);
  assert.equal(offsetAt(fixed, Date.parse("2026-07-15T12:00:00Z")), 180);
  // Same instant, different answers: the zone moves, the fixed offset does not.
  const zoned = { weekday: MONDAY, hour: 19, minute: 0, zone: "Europe/Kyiv" };
  const january = Date.parse("2026-01-15T12:00:00Z");
  assert.equal(offsetAt(zoned, january), 120);
  assert.equal(offsetAt(fixed, january), 180);
  assert.equal(nextDueAfter(january, fixed) - lastDueBefore(january, fixed), WEEK_MS);
});

test("reminder: time and offset parsing accepts real input and rejects nonsense", () => {
  assert.deepEqual(parseTimeOfDay("09:30"), { hour: 9, minute: 30 });
  assert.deepEqual(parseTimeOfDay("9:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseTimeOfDay("23:59"), { hour: 23, minute: 59 });
  assert.equal(parseTimeOfDay("24:00"), null);
  assert.equal(parseTimeOfDay("10:60"), null);
  assert.equal(parseTimeOfDay("10"), null);
  assert.equal(parseTimeOfDay(null), null);

  assert.equal(parseUtcOffset("+3"), 180);
  assert.equal(parseUtcOffset("3"), 180);
  assert.equal(parseUtcOffset("-05:30"), -330);
  assert.equal(parseUtcOffset("UTC+5:45"), 345);
  assert.equal(parseUtcOffset("0"), 0);
  assert.equal(parseUtcOffset("+0330"), 210, "a colon-less offset is HHMM, not minutes");
  assert.equal(parseUtcOffset("180"), null);
  assert.equal(parseUtcOffset("+15"), null);
  assert.equal(parseUtcOffset("abc"), null);
  assert.equal(formatUtcOffset(180), "UTC+03:00");
  assert.equal(formatUtcOffset(-330), "UTC-05:30");
  assert.equal(formatUtcOffset(0), "UTC+00:00");
  assert.equal(formatLocalDateTime(Date.parse("2026-09-16T21:30:00Z"), 180), "17.09.2026 00:30");
  assert.equal(formatLocalDateTime(Date.parse("not a date"), 180), "дата невідома");
});

// --------------------------------------------------------------- router

test("router: command parsing tolerates a bot mention and arguments", () => {
  assert.deepEqual(parseCommand("/gad7"), { command: "gad7", mention: null, args: "" });
  assert.deepEqual(parseCommand("/remind@my_bot off"), { command: "remind", mention: "my_bot", args: "off" });
  assert.deepEqual(parseCommand("  /TZ +3  "), { command: "tz", mention: null, args: "+3" });
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand(""), null);
  assert.deepEqual(parseAnswerCallback("a|7x|2|3"), { sessionId: "7x", itemIndex: 2, value: 3 });
  assert.equal(parseAnswerCallback("a|7x|2"), null);
  assert.equal(parseAnswerCallback("s|gad7"), null);
});

test("router: /start greets, registers the user, and offers both instruments", () => {
  const h = harness();
  const actions = h.say("/start");
  assert.deepEqual(methodsOf(actions), ["sendMessage"]);
  const text = actions[0].payload.text;
  assert.match(text, /Тест/);
  assert.match(text, /GAD-7/);
  assert.match(text, /PHQ-9/);
  assert.match(text, /не діагноз/);
  assert.equal(actions[0].payload.parse_mode, "HTML");
  const buttons = actions[0].payload.reply_markup.inline_keyboard;
  assert.deepEqual(buttons[0].map((button) => button.callback_data), ["s|gad7", "s|phq9"]);
  assert.equal(h.store.user(777).firstSeenAt, "2026-09-16T12:00:00.000Z");
});

test("router: a full GAD-7 run through the keyboard scores and stores the result", () => {
  const h = harness();
  const finished = completeViaKeyboard(h, GAD7, [1, 2, 1, 2, 1, 2, 1]);
  const text = scoreText(finished);
  assert.match(text, /Бали: <b>10<\/b> з 21/);
  assert.match(text, /помірна тривога/);
  assert.match(text, /вище порогу 10/);
  const stored = h.store.lastResult(777, "gad7");
  assert.equal(stored.score, 10);
  assert.deepEqual(stored.answers, [1, 2, 1, 2, 1, 2, 1]);
  assert.equal(h.sessions.size(), 0);
  // The tapped question is rewritten with the chosen answer and no keyboard.
  const edit = finished.find((action) => action.method === "editMessageText");
  assert.ok(edit, "the answered question is edited in place");
  assert.deepEqual(edit.payload.reply_markup, { inline_keyboard: [] });
  assert.match(edit.payload.text, /Відповідь: <b>/);
});

test("router: every answer button fits Telegram's 64 byte callback_data limit", () => {
  const h = harness();
  const actions = h.say("/phq9");
  const keyboard = actions[1].payload.reply_markup.inline_keyboard;
  assert.equal(keyboard.length, 4);
  keyboard.forEach((row) => row.forEach((button) => {
    assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64, button.callback_data);
    assert.match(button.callback_data, /^a\|[a-z0-9]+\|0\|[0-3]$/);
  }));
});

test("router: a stale answer tap is acknowledged without changing the session", () => {
  const h = harness();
  h.say("/gad7");
  const session = h.sessions.get(777, h.clock.now);
  h.tap(["a", session.id, 0, 2].join("|"));
  const repeat = h.tap(["a", session.id, 0, 3].join("|"));
  assert.deepEqual(methodsOf(repeat), ["answerCallbackQuery"]);
  assert.match(repeat[0].payload.text, /вже відповіли/);
  assert.deepEqual(h.sessions.get(777, h.clock.now).answers, [2]);
});

test("router: a bare digit answers the current question and 4 is refused", () => {
  const h = harness();
  h.say("/gad7");
  const advanced = h.say("2");
  assert.match(lastText(advanced), /Питання 2 з 7/);
  assert.deepEqual(h.sessions.get(777, h.clock.now).answers, [2]);
  // Out of range digits are not answers, so they fall through to the hint.
  assert.match(lastText(h.say("4")), /Не зрозумів команду/);
  assert.equal(h.sessions.get(777, h.clock.now).answers.length, 1);
});

test("router: a digit outside a session is a hint, not an answer", () => {
  const h = harness();
  assert.match(lastText(h.say("2")), /Не зрозумів команду/);
  assert.equal(h.store.history(777).length, 0);
});

test("router: PHQ-9 asks the unscored impairment item and shows the support block", () => {
  const h = harness();
  const started = h.say("/phq9");
  assert.match(started[0].payload.text, /Питань: 10/);
  const finished = completeViaKeyboard(h, PHQ9, [2, 2, 2, 2, 2, 2, 2, 2, 1, 3]);
  const text = scoreText(finished);
  assert.match(text, /Бали: <b>17<\/b> з 27/);
  assert.match(text, /Вплив на життя: надзвичайно ускладнювали/);
  assert.match(text, /не залишайтеся з цим наодинці/);
  assert.match(text, /7333/, "the 24 hour crisis line is named");
  const stored = h.store.lastResult(777, "phq9");
  assert.equal(stored.risk, true);
  assert.equal(stored.impairment, 3);
});

test("router: a calm PHQ-9 result omits the support block", () => {
  const h = harness();
  const finished = completeViaKeyboard(h, PHQ9, [0, 1, 0, 1, 0, 0, 1, 0, 0, 0]);
  const text = scoreText(finished);
  assert.match(text, /Бали: <b>3<\/b> з 27/);
  assert.match(text, /нижче порогу 10/);
  assert.doesNotMatch(text, /наодинці/);
});

test("router: a second run reports the change from the previous score", () => {
  const h = harness();
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  h.clock.now += WEEK_MS;
  const second = completeViaKeyboard(h, GAD7, [0, 0, 0, 0, 0, 0, 0]);
  assert.match(scoreText(second), /Динаміка: -7 до минулого разу/);
  h.clock.now += WEEK_MS;
  const third = completeViaKeyboard(h, GAD7, [0, 0, 0, 0, 0, 0, 0]);
  assert.match(scoreText(third), /Динаміка: без змін/);
  assert.equal(h.store.history(777, "gad7").length, 3);
});

test("note: the open question follows the score and the answer is attached to it", () => {
  const h = harness();
  const finished = completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  assert.match(lastText(finished), /Яким був цей тиждень/);
  const skip = finished[finished.length - 1].payload.reply_markup.inline_keyboard[0][0];
  assert.match(skip.callback_data, /^n\|[a-z0-9]+\|skip$/);
  assert.ok(Buffer.byteLength(skip.callback_data, "utf8") <= 64);
  // The score is stored before the question is asked.
  assert.equal(h.store.lastResult(777, "gad7").score, 7);
  assert.equal(h.sessions.pendingNoteCount(), 1);

  const saved = h.say("Важкий тиждень, погано спав і багато дедлайнів");
  assert.match(lastText(saved), /опис збережено/);
  assert.equal(h.store.lastResult(777, "gad7").note, "Важкий тиждень, погано спав і багато дедлайнів");
  assert.equal(h.sessions.pendingNoteCount(), 0);
  // Ordinary text after the prompt is answered is a hint again.
  assert.match(lastText(h.say("ще щось")), /Не зрозумів команду/);
  assert.equal(h.store.lastResult(777, "gad7").note, "Важкий тиждень, погано спав і багато дедлайнів");
});

test("note: skipping keeps the result and records nothing", () => {
  const h = harness();
  const finished = completeViaKeyboard(h, PHQ9, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const pendingId = finished[finished.length - 1].payload.reply_markup.inline_keyboard[0][0]
    .callback_data.split("|")[1];
  const skipped = h.tap("n|" + pendingId + "|skip");
  assert.deepEqual(methodsOf(skipped), ["answerCallbackQuery", "sendMessage"]);
  assert.match(lastText(skipped), /без опису/);
  assert.equal(h.store.lastResult(777, "phq9").score, 0);
  assert.equal(h.store.lastResult(777, "phq9").note, undefined);
  assert.equal(h.sessions.pendingNoteCount(), 0);
  // A stale skip tap is acknowledged and does nothing.
  assert.deepEqual(methodsOf(h.tap("n|" + pendingId + "|skip")), ["answerCallbackQuery"]);
});

test("note: /cancel and a new run drop the prompt without touching the result", () => {
  const h = harness();
  completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  assert.match(lastText(h.say("/cancel")), /без опису/);
  assert.equal(h.sessions.pendingNoteCount(), 0);
  assert.equal(h.store.lastResult(777, "gad7").score, 14);

  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  h.say("/phq9");
  assert.equal(h.sessions.pendingNoteCount(), 0, "starting a questionnaire drops the prompt");
  h.say("це не опис, а відповідь на питання");
  assert.equal(h.store.lastResult(777, "gad7").note, undefined);
});

test("note: reading commands leave the prompt open", () => {
  const h = harness();
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  h.say("/results");
  assert.equal(h.sessions.pendingNoteCount(), 1);
  h.say("тиждень був спокійний");
  assert.equal(h.store.lastResult(777, "gad7").note, "тиждень був спокійний");
});

test("note: an over-long note is truncated and markup in it is escaped", () => {
  const h = harness();
  completeViaKeyboard(h, GAD7, [0, 0, 0, 0, 0, 0, 0]);
  const saved = h.say("я".repeat(MAX_NOTE_LENGTH + 500));
  assert.equal(h.store.lastResult(777, "gad7").note.length, MAX_NOTE_LENGTH);
  assert.match(lastText(saved), /перші 1000 символів/);

  const other = harness();
  completeViaKeyboard(other, GAD7, [0, 0, 0, 0, 0, 0, 0]);
  other.say("<b>стало</b> & краще");
  assert.equal(other.store.lastResult(777, "gad7").note, "<b>стало</b> & краще");
  const shown = lastText(other.say("/last"));
  assert.match(shown, /&lt;b&gt;стало&lt;\/b&gt; &amp; краще/);
  assert.doesNotMatch(shown, /<b>стало<\/b>/);
});

test("note: blank input is not a note and an empty note is dropped", () => {
  const h = harness();
  completeViaKeyboard(h, GAD7, [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(h.say("   "), [], "whitespace is neither a note nor a hint");
  assert.equal(h.sessions.pendingNoteCount(), 1, "the prompt stays open");
  h.say("норм");
  assert.equal(h.store.lastResult(777, "gad7").note, "норм");
});

test("note: history shows a snippet, /last shows it in full, /export includes it", () => {
  const h = harness();
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  const long = "Спочатку було важко через переїзд, потім стало легше, бо почав гуляти щодня і нормально спати";
  h.say(long);
  const history = lastText(h.say("/results"));
  assert.match(history, /<i>Спочатку було важко/);
  assert.match(history, /\.\.\.<\/i>/, "the list carries a snippet, not the whole note");
  assert.match(lastText(h.say("/last")), new RegExp(long.slice(0, 40)));
  assert.match(lastText(h.say("/export")), /Спочатку було важко/);
});

test("note: a result that no longer exists cannot be annotated", () => {
  const h = harness();
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  h.store.forget(777);
  const answered = h.say("тиждень нормальний");
  assert.match(lastText(answered), /без опису/);
  assert.equal(h.store.history(777).length, 0);
});

test("note: the prompt expires with the session idle timeout", () => {
  const h = harness({ config: { sessionIdleTimeoutMs: 1000 } });
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  h.clock.now += 2000;
  assert.match(lastText(h.say("пізній опис")), /Не зрозумів команду/);
  assert.equal(h.store.lastResult(777, "gad7").note, undefined);
});

test("note: a snapshot round-trips the note and bounds a hand-edited one", () => {
  const file = join(DIR, "notes.json");
  const first = new Store({ file, writeDelayMs: 1e9 });
  const stored = first.addResult(21, buildResult(GAD7, [1, 1, 1, 1, 1, 1, 1], WED_NOON_UTC));
  assert.equal(first.annotateResult(21, stored, "  тиждень зі стресом  "), stored);
  assert.equal(stored.note, "тиждень зі стресом", "the note is trimmed");
  assert.equal(first.annotateResult(21, stored, "   "), stored);
  assert.equal(stored.note, undefined, "a blank note removes the field");
  first.annotateResult(21, stored, "фінальний опис");
  first.flush();

  const second = new Store({ file });
  second.load();
  assert.equal(second.lastResult(21, "gad7").note, "фінальний опис");
  assert.equal(second.annotateResult(21, { instrument: "gad7", score: 1 }, "чужий"), null,
    "a result that is not in this history cannot be annotated");

  const hand = join(DIR, "hand-note.json");
  writeFileSync(hand, JSON.stringify({
    version: 1,
    users: { "22": { results: [{ instrument: "gad7", score: 3, note: "x".repeat(MAX_NOTE_LENGTH + 40) },
      { instrument: "gad7", score: 4, note: "   " }] } },
  }));
  const third = new Store({ file: hand });
  third.load();
  const entries = third.history(22).reverse();
  assert.equal(entries[0].note.length, MAX_NOTE_LENGTH);
  assert.equal(entries[1].note, undefined);
});

test("router: /cancel drops an unfinished run and stores nothing", () => {
  const h = harness();
  h.say("/gad7");
  h.say("1");
  assert.match(lastText(h.say("/cancel")), /перервано/);
  assert.equal(h.sessions.size(), 0);
  assert.equal(h.store.history(777).length, 0);
  assert.match(lastText(h.say("/cancel")), /Немає чого перервати/);
});

test("router: starting the other instrument replaces the run in progress", () => {
  const h = harness();
  h.say("/gad7");
  h.say("3");
  h.say("/phq9");
  const session = h.sessions.get(777, h.clock.now);
  assert.equal(session.instrumentId, "phq9");
  assert.deepEqual(session.answers, []);
  assert.equal(h.store.history(777).length, 0);
});

test("router: /results and /last read the stored history", () => {
  const h = harness();
  assert.match(lastText(h.say("/results")), /ще немає проходжень/);
  assert.match(lastText(h.say("/last")), /немає даних/);
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  const results = lastText(h.say("/results"));
  assert.match(results, /16\.09\.2026 15:00 : <b>7<\/b>\/21/);
  assert.match(lastText(h.say("/last")), /GAD-7<\/b>: 7\/21/);
  assert.match(lastText(h.tap("h|all")), /Історія результатів/);
});

test("router: reminder settings can be read, disabled, re-enabled, and retimed", () => {
  const h = harness();
  assert.match(lastText(h.say("/remind")), /Нагадування<\/b>: увімкнені/);
  assert.match(lastText(h.say("/remind")), /День: понеділок, час 19:00/);
  assert.match(lastText(h.say("/remind")), /Наступне: 21\.09\.2026 19:00/);
  assert.match(lastText(h.say("/remind off")), /вимкнені/);
  assert.equal(h.store.user(777).remindersEnabled, false);
  assert.match(lastText(h.say("/remind on")), /увімкнені/);
  assert.equal(h.store.user(777).remindersEnabled, true);
  assert.match(lastText(h.say("/remind 09:30")), /понеділок, час 09:30/);
  assert.equal(h.store.user(777).reminderTime, "09:30");
  h.say("/remind 9:05");
  assert.equal(h.store.user(777).reminderTime, "09:05", "the stored time is normalized");
  h.say("/remind 09:30");
  assert.match(lastText(h.say("/remind 99:99")), /ГГ:ХХ/);
  assert.equal(h.store.user(777).reminderTime, "09:30");
  assert.match(lastText(h.tap("r|off")), /вимкнені/);
  assert.equal(h.store.user(777).remindersEnabled, false);
  assert.match(lastText(h.tap("r|status")), /Нагадування/);
});

test("router: /tz changes the offset used for display and scheduling", () => {
  const h = harness();
  assert.match(lastText(h.say("/tz")), /UTC\+03:00/);
  assert.match(lastText(h.say("/tz -08:00")), /UTC-08:00/);
  assert.equal(h.store.user(777).tzOffsetMinutes, -480);
  assert.match(lastText(h.say("/remind")), /UTC-08:00/);
  assert.match(lastText(h.say("/tz nonsense")), /Не зрозумів зсув/);
  assert.equal(h.store.user(777).tzOffsetMinutes, -480);
  completeViaKeyboard(h, GAD7, [0, 0, 0, 0, 0, 0, 0]);
  // 12:00 UTC is 04:00 in UTC-8.
  assert.match(lastText(h.say("/last")), /16\.09\.2026 04:00/);
});

test("router: /tz auto returns to the automatic zone", () => {
  const h = harness({ config: { reminder: { time: "19:00", weekday: 1, zone: "Europe/Kyiv", offsetMinutes: null, graceMs: 12 * 60 * 60 * 1000 } } });
  assert.match(lastText(h.say("/remind")), /Europe\/Kyiv/);
  assert.match(lastText(h.say("/remind")), /перехід на літній час враховується/);

  h.say("/tz +5");
  assert.equal(h.store.user(777).tzOffsetMinutes, 300);
  assert.match(lastText(h.say("/remind")), /UTC\+05:00, фіксований зсув/);

  assert.match(lastText(h.say("/tz auto")), /автоматичний часовий пояс/);
  assert.equal(h.store.user(777).tzOffsetMinutes, null);
  assert.match(lastText(h.say("/remind")), /Europe\/Kyiv/);

  // With the server pinned to a fixed offset there is nothing to return to.
  const pinned = harness();
  assert.match(lastText(pinned.say("/tz auto")), /недоступний/);
});

test("router: /export returns the caller's own data as JSON", () => {
  const h = harness();
  completeViaKeyboard(h, GAD7, [1, 0, 1, 0, 1, 0, 1]);
  const text = lastText(h.say("/export"));
  assert.match(text, /<pre>/);
  assert.match(text, /&quot;chatId&quot;: 777|"chatId": 777/);
  assert.match(text, /gad7/);
});

test("router: /delete asks before wiping and then removes everything", () => {
  const h = harness();
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  const prompt = h.say("/delete");
  const confirm = prompt[0].payload.reply_markup.inline_keyboard[0];
  assert.deepEqual(confirm.map((button) => button.callback_data), ["del|yes", "del|no"]);
  assert.match(lastText(h.tap("del|no")), /скасовано/);
  assert.equal(h.store.history(777).length, 1);
  const deleted = h.tap("del|yes");
  assert.match(lastText(deleted), /Усі дані видалено/);
  assert.equal(h.store.hasUser(777), false);
  assert.equal(h.store.history(777).length, 0);
});

test("router: a group chat is refused so answers stay private", () => {
  const h = harness();
  const group = { id: -100, type: "supergroup" };
  const actions = h.router.handleUpdate({ update_id: 3, message: { message_id: 1, chat: group, text: "/gad7" } });
  assert.match(lastText(actions), /лише в особистому чаті/);
  assert.equal(h.sessions.size(), 0);
  const chatter = h.router.handleUpdate({ update_id: 4, message: { message_id: 2, chat: group, text: "привіт" } });
  assert.deepEqual(chatter, [], "ordinary group chatter is ignored");
});

test("router: unknown commands, empty updates, and stray callbacks stay harmless", () => {
  const h = harness();
  assert.match(lastText(h.say("/unknown")), /Не зрозумів команду/);
  assert.deepEqual(h.router.handleUpdate({}), []);
  assert.deepEqual(h.router.handleUpdate(null), []);
  assert.deepEqual(h.router.handleUpdate({ update_id: 5, edited_message: {} }), []);
  assert.deepEqual(methodsOf(h.tap("mystery")), ["answerCallbackQuery"]);
  assert.deepEqual(methodsOf(h.tap("a|nosession|0|1")), ["answerCallbackQuery", "sendMessage"]);
  assert.match(lastText(h.tap("s|unknown")), /Невідомий опитувальник/);
});

test("router: a start button launches the instrument", () => {
  const h = harness();
  const actions = h.tap("s|phq9");
  assert.deepEqual(methodsOf(actions), ["answerCallbackQuery", "sendMessage", "sendMessage"]);
  assert.equal(h.sessions.get(777, h.clock.now).instrumentId, "phq9");
});

test("router: display names cannot inject HTML into a message", () => {
  const h = harness();
  const actions = h.router.handleUpdate({
    update_id: 6,
    message: { message_id: 1, chat: h.chat, from: { id: 777, first_name: "<b>x</b>&" }, text: "/start" },
  });
  assert.match(actions[0].payload.text, /&lt;b&gt;x&lt;\/b&gt;&amp;/);
  assert.equal(escapeHtml("<&>"), "&lt;&amp;&gt;");
});

test("router: the weekly reminder quotes the last score of each instrument", () => {
  const h = harness();
  const schedule = resolveSchedule(null, h.config.reminder);
  assert.match(weeklyReminder(h.store, 777, schedule), /ще не проходили/);
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  const text = weeklyReminder(h.store, 777, schedule);
  assert.match(text, /Понеділок/);
  assert.match(text, /GAD-7: минулий бал 7\/21/);
  assert.match(text, /PHQ-9: ще не проходили/);
  const actions = h.router.reminderActions(777, text);
  assert.deepEqual(methodsOf(actions), ["sendMessage"]);
  assert.ok(actions[0].payload.reply_markup.inline_keyboard.length >= 1);
});

// --------------------------------------------------------------- mini app

test("webapp: the app's copy of the questionnaires is identical to the bot's", () => {
  assert.equal(isCurrent(), true,
    "run node telegram-bot/webapp/build.mjs after changing src/instruments.mjs");
  assert.equal(readFileSync(COPY, "utf8"), readFileSync(SOURCE, "utf8"));
});

test("webapp: the page and its script exist and reference each other", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "..", "webapp", "index.html"), "utf8");
  const app = readFileSync(join(here, "..", "webapp", "app.js"), "utf8");
  assert.match(html, /telegram-web-app\.js/, "the Telegram bridge is loaded");
  assert.match(html, /<script type="module" src="\.\/app\.js">/);
  assert.match(app, /from "\.\/instruments\.mjs"/, "questions come from the shared copy");
  // Both severity scales appear in the app through the shared definitions, so
  // the page itself must not restate a band or a question.
  assert.doesNotMatch(html, /тривоги або напруження/, "the page must not restate an item");
  assert.doesNotMatch(app, /помірно тяжкі/, "the script must not restate a band");
});

test("webapp: a well formed result payload is accepted and normalized", () => {
  const ok = parseWebAppPayload(JSON.stringify({
    v: 1, type: "result", instrument: "gad7", answers: [1, 2, 1, 2, 1, 2, 1], note: "  тиждень так собі  ",
  }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.payload, {
    type: "result", instrumentId: "gad7", answers: [1, 2, 1, 2, 1, 2, 1], note: "тиждень так собі",
  });
  const blankNote = parseWebAppPayload(JSON.stringify({
    v: 1, type: "result", instrument: "phq9", answers: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], note: "   ",
  }));
  assert.equal(blankNote.payload.note, null);
  const noNote = parseWebAppPayload(JSON.stringify({
    v: 1, type: "result", instrument: "phq9", answers: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  }));
  assert.equal(noNote.payload.note, null);
});

test("webapp: every malformed payload is refused with a reason", () => {
  const cases = [
    ["", /empty payload/],
    ["not json", /not JSON/],
    ["[]", /not an object/],
    ['{"v":2,"type":"result"}', /unsupported payload version 2/],
    ['{"v":1,"type":"mystery"}', /unknown payload type/],
    ['{"v":1,"type":"result","instrument":"bdi","answers":[]}', /unknown instrument/],
    ['{"v":1,"type":"result","instrument":"gad7","answers":"1234567"}', /must be an array/],
    ['{"v":1,"type":"result","instrument":"gad7","answers":[1,1,1]}', /exactly 7 answers/],
    ['{"v":1,"type":"result","instrument":"gad7","answers":[1,1,1,1,1,1,4]}', /outside the option set/],
    ['{"v":1,"type":"result","instrument":"gad7","answers":[1,1,1,1,1,1,1.5]}', /not an integer/],
    ['{"v":1,"type":"result","instrument":"gad7","answers":[1,1,1,1,1,1,1],"note":7}', /note must be a string/],
    ['{"v":1,"type":"reminders"}', /changes nothing/],
    ['{"v":1,"type":"reminders","enabled":"yes"}', /must be a boolean/],
    ['{"v":1,"type":"reminders","time":"25:00"}', /time must be/],
    ['{"v":1,"type":"reminders","tz":900}', /within 14 hours/],
    ['{"v":1,"type":"reminders","tz":1.5}', /within 14 hours/],
  ];
  cases.forEach(([raw, pattern]) => {
    const outcome = parseWebAppPayload(raw);
    assert.equal(outcome.ok, false, raw);
    assert.match(outcome.reason, pattern, raw);
  });
  // Telegram caps sendData at 4096 bytes; a longer payload is refused here too.
  const huge = JSON.stringify({
    v: 1, type: "result", instrument: "gad7", answers: [0, 0, 0, 0, 0, 0, 0], note: "я".repeat(3000),
  });
  assert.ok(Buffer.byteLength(huge, "utf8") > MAX_PAYLOAD_BYTES);
  assert.match(parseWebAppPayload(huge).reason, /over 4096 bytes/);
  assert.equal(parseWebAppPayload(null).ok, false);
});

test("webapp: a note at the bound stays inside one sendData payload", () => {
  const payload = JSON.stringify({
    v: 1, type: "result", instrument: "phq9", answers: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
    note: "я".repeat(1000),
  });
  assert.ok(Buffer.byteLength(payload, "utf8") <= MAX_PAYLOAD_BYTES,
    "1000 Cyrillic characters plus the answers must fit Telegram's limit");
  assert.equal(parseWebAppPayload(payload).ok, true);
});

test("webapp: a result from the app is rescored, stored, and reported in the chat", () => {
  const h = harness({ config: { webappUrl: "https://example.pages.dev/" } });
  const actions = h.router.handleUpdate({
    update_id: 7,
    message: {
      message_id: 1,
      chat: h.chat,
      web_app_data: {
        button_text: "Відкрити застосунок",
        data: JSON.stringify({
          v: 1, type: "result", instrument: "gad7", answers: [2, 2, 2, 2, 2, 2, 2], note: "виснажливий тиждень",
        }),
      },
    },
  });
  assert.match(textsOf(actions)[0], /Збережено із застосунку/);
  assert.match(textsOf(actions)[0], /14\/21/);
  assert.match(scoreText(actions), /Бали: <b>14<\/b> з 21/);
  const stored = h.store.lastResult(777, "gad7");
  assert.equal(stored.score, 14, "the score is computed by the bot, not taken from the payload");
  assert.equal(stored.severity, "помірна тривога");
  assert.equal(stored.note, "виснажливий тиждень");
  // No chat-side prompt is left dangling after an app submission.
  assert.equal(h.sessions.pendingNoteCount(), 0);
  assert.equal(h.sessions.size(), 0);
});

test("webapp: a fabricated score in the payload is ignored", () => {
  const h = harness({ config: { webappUrl: "https://example.pages.dev/" } });
  h.router.handleUpdate({
    update_id: 8,
    message: {
      message_id: 1,
      chat: h.chat,
      web_app_data: {
        data: JSON.stringify({
          v: 1, type: "result", instrument: "gad7", answers: [0, 0, 0, 0, 0, 0, 0], score: 21, severity: "вигадка",
        }),
      },
    },
  });
  const stored = h.store.lastResult(777, "gad7");
  assert.equal(stored.score, 0);
  assert.equal(stored.severity, "мінімальна тривога");
});

test("webapp: a rejected payload answers with a recovery hint and stores nothing", () => {
  const h = harness({ config: { webappUrl: "https://example.pages.dev/" } });
  const actions = h.router.handleUpdate({
    update_id: 9,
    message: { message_id: 1, chat: h.chat, web_app_data: { data: "{\"v\":1,\"type\":\"result\"}" } },
  });
  assert.match(lastText(actions), /Не вдалося прочитати дані/);
  assert.equal(h.store.history(777).length, 0);
  const outcome = h.router.handleWebAppData(777, "{oops");
  assert.match(outcome.reason, /not JSON/);
});

test("webapp: the app can hand the user back to the automatic zone", () => {
  const h = harness({ config: { webappUrl: "https://example.pages.dev/", reminder: { time: "19:00", weekday: 1, zone: "Europe/Kyiv", offsetMinutes: null, graceMs: 12 * 60 * 60 * 1000 } } });
  h.say("/tz +5");
  assert.equal(h.store.user(777).tzOffsetMinutes, 300);
  const actions = h.router.handleUpdate({
    update_id: 12,
    message: {
      message_id: 1,
      chat: h.chat,
      web_app_data: { data: JSON.stringify({ v: 1, type: "reminders", enabled: true, time: "19:00", tz: "auto" }) },
    },
  });
  assert.equal(h.store.user(777).tzOffsetMinutes, null);
  assert.match(lastText(actions), /Europe\/Kyiv/);
  // Anything else in that field is still refused.
  assert.match(parseWebAppPayload(JSON.stringify({ v: 1, type: "reminders", tz: "kyiv" })).reason,
    /within 14 hours of UTC, or the string auto/);
});

test("webapp: reminder settings from the app are applied and echoed", () => {
  const h = harness({ config: { webappUrl: "https://example.pages.dev/" } });
  const actions = h.router.handleUpdate({
    update_id: 10,
    message: {
      message_id: 1,
      chat: h.chat,
      web_app_data: { data: JSON.stringify({ v: 1, type: "reminders", enabled: true, time: "08:15", tz: 120 }) },
    },
  });
  assert.match(lastText(actions), /понеділок, час 08:15/);
  assert.match(lastText(actions), /UTC\+02:00, фіксований зсув/);
  const user = h.store.user(777);
  assert.equal(user.remindersEnabled, true);
  assert.equal(user.reminderTime, "08:15");
  assert.equal(user.tzOffsetMinutes, 120);
});

test("webapp: deletion from the app asks in the chat instead of wiping at once", () => {
  const h = harness({ config: { webappUrl: "https://example.pages.dev/" } });
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  const actions = h.router.handleUpdate({
    update_id: 11,
    message: { message_id: 1, chat: h.chat, web_app_data: { data: JSON.stringify({ v: 1, type: "delete" }) } },
  });
  assert.match(lastText(actions), /Дію не можна скасувати/);
  assert.equal(h.store.history(777).length, 1, "nothing is deleted before the confirmation");
  h.tap("del|yes");
  assert.equal(h.store.hasUser(777), false);
});

test("webapp: /start offers the launch button only when a URL is configured", () => {
  const withApp = harness({ config: { webappUrl: "https://example.pages.dev/" } });
  const started = withApp.say("/start");
  const keyboard = started[0].payload.reply_markup.keyboard;
  assert.equal(keyboard[0][0].web_app.url, "https://example.pages.dev/");
  assert.match(keyboard[0][0].text, /Відкрити застосунок/);
  assert.equal(started[0].payload.reply_markup.is_persistent, true);
  assert.match(lastText(started), /вікно поверх чату/);
  assert.match(lastText(withApp.say("/app")), /Відкрити застосунок/);

  const chatOnly = harness();
  const plain = chatOnly.say("/start");
  assert.equal(plain.length, 1);
  assert.ok(plain[0].payload.reply_markup.inline_keyboard, "the chat flow keeps its inline buttons");
  assert.match(lastText(chatOnly.say("/app")), /не налаштований/);
});

test("webapp: WEBAPP_URL must be https", () => {
  const good = loadConfig({ BOT_TOKEN: FAKE_TOKEN, WEBAPP_URL: "https://example.pages.dev/" }, { envFile: false });
  assert.equal(good.webappUrl, "https://example.pages.dev/");
  assert.equal(loadConfig({ BOT_TOKEN: FAKE_TOKEN }, { envFile: false }).webappUrl, null);
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, WEBAPP_URL: "http://example.com" }, { envFile: false }),
    /must be an https URL/);
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, WEBAPP_URL: "example.com" }, { envFile: false }),
    /must be an https URL/);
});

// --------------------------------------------------------------- deployment

test("deploy: the shell scripts parse", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy");
  ["install.sh", "backup.sh"].forEach((name) => {
    const result = spawnSync("bash", ["-n", join(dir, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, name + ": " + (result.stderr || ""));
  });
});

test("deploy: the unit, the installer and the guide agree on every path", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy");
  const unit = readFileSync(join(dir, "gad7-phq9-bot.service"), "utf8");
  const installer = readFileSync(join(dir, "install.sh"), "utf8");
  const backup = readFileSync(join(dir, "backup.sh"), "utf8");
  const guide = readFileSync(join(dir, "DEPLOY.md"), "utf8");

  // A path that drifts between these files leaves a service that starts
  // nothing, or a backup that copies the wrong file.
  const appDir = "/opt/gad7-phq9-bot";
  const envFile = "/etc/gad7-phq9-bot.env";
  const stateDir = "/var/lib/gad7-phq9-bot";
  assert.match(unit, new RegExp("ExecStart=/usr/bin/node " + appDir + "/telegram-bot/bot\\.mjs"));
  assert.match(unit, new RegExp("EnvironmentFile=" + envFile));
  assert.match(unit, /StateDirectory=gad7-phq9-bot/);
  assert.match(installer, new RegExp("APP_DIR=" + appDir));
  assert.match(installer, new RegExp("ENV_FILE=" + envFile));
  assert.match(backup, new RegExp("DATA_FILE:-" + stateDir + "/results\\.json"));
  assert.match(guide, new RegExp(envFile.replace(/\//g, "/")));

  // The env template must name the variables the bot actually reads.
  ["BOT_TOKEN", "DATA_FILE", "REMINDER_TIME", "REMINDER_UTC_OFFSET", "WEBAPP_URL"].forEach((key) => {
    assert.match(installer, new RegExp("^" + key + "=", "m"), key + " missing from the env template");
  });
  // V8 needs writable executable memory, so this hardening switch must stay off.
  assert.doesNotMatch(unit, /^MemoryDenyWriteExecute=yes/m);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /User=gad7bot/);
});

// --------------------------------------------------------------- telegram client

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => handler(request, response, Buffer.concat(chunks).toString("utf8")));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const closeServer = (server) => new Promise((done) => server.close(done));

test("telegram: a successful call posts JSON to the token path and returns the result", async () => {
  const seen = [];
  const { server, port } = await startServer((request, response, body) => {
    seen.push({ url: request.url, method: request.method, type: request.headers["content-type"], body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: { id: 1, username: "test_bot" } }));
  });
  try {
    const client = new TelegramClient({ token: FAKE_TOKEN, apiBase: "http://127.0.0.1:" + port });
    const me = await client.getMe();
    assert.equal(me.username, "test_bot");
    const sent = await client.sendMessage(5, "привіт", { parse_mode: "HTML" });
    assert.equal(sent.id, 1);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].url, "/bot" + FAKE_TOKEN + "/getMe");
    assert.equal(seen[1].method, "POST");
    assert.equal(seen[1].type, "application/json");
    assert.deepEqual(JSON.parse(seen[1].body), { chat_id: 5, text: "привіт", parse_mode: "HTML" });
  } finally {
    await closeServer(server);
  }
});

test("telegram: getUpdates sends the offset, the long poll timeout, and the update filter", async () => {
  let body = null;
  const { server, port } = await startServer((request, response, raw) => {
    body = JSON.parse(raw);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: [] }));
  });
  try {
    const client = new TelegramClient({ token: FAKE_TOKEN, apiBase: "http://127.0.0.1:" + port });
    await client.getUpdates({ offset: 99, timeoutSeconds: 1 });
    assert.equal(body.offset, 99);
    assert.equal(body.timeout, 1);
    assert.deepEqual(body.allowed_updates, ["message", "callback_query"]);
  } finally {
    await closeServer(server);
  }
});

test("telegram: a 400 is fatal and is not retried", async () => {
  let attempts = 0;
  const { server, port } = await startServer((request, response) => {
    attempts++;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
  });
  try {
    const client = new TelegramClient({ token: FAKE_TOKEN, apiBase: "http://127.0.0.1:" + port, maxAttempts: 3 });
    await assert.rejects(() => client.sendMessage(1, "x"), (error) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.fatal, true);
      assert.equal(error.status, 400);
      assert.match(error.message, /chat not found/);
      return true;
    });
    assert.equal(attempts, 1);
  } finally {
    await closeServer(server);
  }
});

test("telegram: a 429 is retried after the requested delay", async () => {
  let attempts = 0;
  const { server, port } = await startServer((request, response) => {
    attempts++;
    if (attempts === 1) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: true }));
  });
  try {
    const client = new TelegramClient({ token: FAKE_TOKEN, apiBase: "http://127.0.0.1:" + port, maxAttempts: 3 });
    assert.equal(await client.sendMessage(1, "x"), true);
    assert.equal(attempts, 2);
  } finally {
    await closeServer(server);
  }
});

test("telegram: a 500 stays retryable and invalid JSON is reported with the status", async () => {
  const { server, port } = await startServer((request, response) => {
    if (request.url.endsWith("/getMe")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, description: "Internal Server Error" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>not json</html>");
  });
  try {
    const client = new TelegramClient({ token: FAKE_TOKEN, apiBase: "http://127.0.0.1:" + port });
    await assert.rejects(() => client.call("getMe", {}, { maxAttempts: 1 }), (error) => {
      assert.equal(error.fatal, false);
      assert.equal(error.status, 500);
      return true;
    });
    await assert.rejects(() => client.call("sendMessage", {}, { maxAttempts: 1 }), /invalid JSON \(status 200\)/);
  } finally {
    await closeServer(server);
  }
});

test("telegram: the token never appears in an error message", async () => {
  const { server, port } = await startServer((request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden for " + FAKE_TOKEN }));
  });
  try {
    const client = new TelegramClient({ token: FAKE_TOKEN, apiBase: "http://127.0.0.1:" + port });
    await assert.rejects(() => client.sendMessage(1, "x"), (error) => {
      assert.doesNotMatch(error.message, /AAFakeToken/);
      assert.match(error.message, /<token>/);
      assert.equal(error.status, 403);
      assert.equal(error.fatal, true);
      return true;
    });
    assert.equal(client.redact("url /bot" + FAKE_TOKEN + "/x"), "url /bot<token>/x");
  } finally {
    await closeServer(server);
  }
});

test("telegram: a client without a token is refused", () => {
  assert.throws(() => new TelegramClient({}), /needs a bot token/);
});

// --------------------------------------------------------------- config

test("config: .env parsing ignores comments, blanks, and junk lines", () => {
  const values = parseEnvFile([
    "# comment",
    "",
    "BOT_TOKEN=abc:def",
    "REMINDER_TIME = 09:30 ",
    "QUOTED=\"10:00\"",
    "not a pair",
  ].join("\n"));
  assert.deepEqual(values, { BOT_TOKEN: "abc:def", REMINDER_TIME: "09:30", QUOTED: "10:00" });
});

test("config: a valid environment produces resolved reminder defaults", () => {
  const config = loadConfig({
    BOT_TOKEN: FAKE_TOKEN,
    MEMORY_ONLY: "1",
    REMINDER_TIME: "09:30",
    REMINDER_UTC_OFFSET: "-05:30",
    REMINDER_GRACE_HOURS: "6",
  }, { envFile: false });
  assert.equal(config.token, FAKE_TOKEN);
  assert.equal(config.dataFile, null);
  assert.equal(config.memoryOnly, true);
  assert.equal(config.reminder.time, "09:30");
  assert.equal(config.reminder.offsetMinutes, -330);
  assert.equal(config.reminder.zone, null);
  assert.equal(config.reminder.graceMs, 6 * 60 * 60 * 1000);
  assert.match(config.crisisContact, /7333/);
  assert.match(config.crisisContact, /howareu\.com/);
});

test("config: the reminder defaults to Monday 19:00 in the Kyiv zone", () => {
  const config = loadConfig({ BOT_TOKEN: FAKE_TOKEN }, { envFile: false });
  assert.equal(config.reminder.time, "19:00");
  assert.equal(config.reminder.weekday, 1);
  assert.equal(config.reminder.zone, "Europe/Kyiv");
  assert.equal(config.reminder.offsetMinutes, null, "the zone carries the offset, not a constant");

  // An explicit offset replaces the zone entirely.
  const pinned = loadConfig({ BOT_TOKEN: FAKE_TOKEN, REMINDER_UTC_OFFSET: "+2" }, { envFile: false });
  assert.equal(pinned.reminder.zone, null);
  assert.equal(pinned.reminder.offsetMinutes, 120);

  const sunday = loadConfig({ BOT_TOKEN: FAKE_TOKEN, REMINDER_WEEKDAY: "0" }, { envFile: false });
  assert.equal(sunday.reminder.weekday, 0);
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, REMINDER_WEEKDAY: "7" }, { envFile: false }),
    /REMINDER_WEEKDAY must be 0/);
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, REMINDER_ZONE: "Mars/Olympus" }, { envFile: false }),
    /unknown to this runtime/);
});

test("config: bad input fails closed with an explanation", () => {
  assert.throws(() => loadConfig({}, { envFile: false }), /BOT_TOKEN is not set/);
  assert.throws(() => loadConfig({ BOT_TOKEN: "nope" }, { envFile: false }), /does not look like a Telegram token/);
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, REMINDER_TIME: "25:00" }, { envFile: false }),
    /REMINDER_TIME/);
  // An empty offset is not an error: it means "use the zone".
  assert.equal(loadConfig({ BOT_TOKEN: FAKE_TOKEN, REMINDER_UTC_OFFSET: "" }, { envFile: false })
    .reminder.zone, "Europe/Kyiv");
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, REMINDER_UTC_OFFSET: "nope" }, { envFile: false }),
    /REMINDER_UTC_OFFSET/);
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, TICK_SECONDS: "0" }, { envFile: false }),
    /TICK_SECONDS must be a positive number/);
});

test("config: a data file path is resolved when persistence is on", () => {
  const config = loadConfig({ BOT_TOKEN: FAKE_TOKEN, DATA_FILE: join(DIR, "results.json") }, { envFile: false });
  assert.equal(config.memoryOnly, false);
  assert.equal(config.dataFile, join(DIR, "results.json"));
});

// --------------------------------------------------------------- runtime

class FakeClient {
  constructor() {
    this.calls = [];
    this.updates = [];
    this.failWith = null;
  }
  redact(text) { return String(text); }
  async call(method, payload) {
    this.calls.push({ method, payload });
    if (this.failWith) throw this.failWith;
    return {};
  }
  async getUpdates() {
    return this.updates.shift() || [];
  }
}

function runtimeHarness(overrides = {}) {
  const config = fixtureConfig(overrides.config);
  const parts = buildBot(config);
  const client = new FakeClient();
  const runtime = new BotRuntime({ client, config, store: parts.store, sessions: parts.sessions, router: parts.router });
  return { config, client, runtime, store: parts.store };
}

test("runtime: a poll dispatches the update, answers it, and advances the offset", async () => {
  const h = runtimeHarness();
  h.client.updates.push([{ update_id: 500, message: { message_id: 1, chat: { id: 8, type: "private" }, text: "/start" } }]);
  assert.equal(await h.runtime.pollOnce(), 1);
  assert.equal(h.store.offset, 501);
  assert.deepEqual(h.client.calls.map((call) => call.method), ["sendMessage"]);
  assert.equal(h.client.calls[0].payload.chat_id, 8);
});

test("runtime: the Monday sweep reminds once per weekly slot", async () => {
  const h = runtimeHarness();
  h.store.updateUser(8, { remindersEnabled: true });
  const reminded = await h.runtime.sweepReminders(JUST_AFTER_SLOT);
  assert.deepEqual(reminded, [8]);
  assert.equal(h.store.user(8).lastRemindedAt, MONDAY_SLOT_UTC);
  assert.match(h.client.calls[0].payload.text, /Понеділок/);
  // The same slot must not fire again, the next week must.
  assert.deepEqual(await h.runtime.sweepReminders(JUST_AFTER_SLOT + 60000), []);
  assert.deepEqual(await h.runtime.sweepReminders(JUST_AFTER_SLOT + WEEK_MS), [8]);
  assert.equal(h.store.user(8).lastRemindedAt, MONDAY_SLOT_UTC + WEEK_MS);
  // Two days later the slot is outside the grace window and is not sent late.
  h.store.updateUser(9, { remindersEnabled: true });
  assert.deepEqual(await h.runtime.sweepReminders(WED_NOON_UTC), []);
});

test("runtime: a user who disabled reminders is never swept", async () => {
  const h = runtimeHarness();
  h.store.updateUser(8, { remindersEnabled: false });
  assert.deepEqual(await h.runtime.sweepReminders(JUST_AFTER_SLOT), []);
  assert.equal(h.client.calls.length, 0);
});

test("runtime: a 403 from a reminder disables that chat instead of looping", async () => {
  const h = runtimeHarness();
  h.store.updateUser(8, { remindersEnabled: true });
  h.client.failWith = new TelegramError("blocked", { status: 403, fatal: true });
  assert.deepEqual(await h.runtime.sweepReminders(JUST_AFTER_SLOT), []);
  assert.equal(h.store.user(8).remindersEnabled, false);
  assert.equal(h.store.user(8).lastRemindedAt, MONDAY_SLOT_UTC);
});

test("runtime: a transient reminder failure leaves the slot pending", async () => {
  const h = runtimeHarness();
  h.store.updateUser(8, { remindersEnabled: true });
  h.client.failWith = new TelegramError("boom", { status: 500 });
  assert.deepEqual(await h.runtime.sweepReminders(JUST_AFTER_SLOT), []);
  assert.equal(h.store.user(8).lastRemindedAt, 0);
  h.client.failWith = null;
  assert.deepEqual(await h.runtime.sweepReminders(JUST_AFTER_SLOT), [8]);
});

test("runtime: a router failure on one update does not stop the poll loop", async () => {
  const h = runtimeHarness();
  h.runtime.router = {
    handleUpdate() { throw new Error("router exploded"); },
    reminderActions: () => [],
  };
  h.client.updates.push([{ update_id: 9, message: { chat: { id: 1, type: "private" }, text: "/start" } }]);
  assert.equal(await h.runtime.pollOnce(), 1);
  assert.equal(h.store.offset, 10);
  assert.equal(h.client.calls.length, 0);
});

test("runtime: results survive a restart through the snapshot file", async () => {
  const file = join(DIR, "restart.json");
  const first = runtimeHarness({ config: { dataFile: file, memoryOnly: false } });
  first.client.updates.push([
    { update_id: 1, message: { message_id: 1, chat: { id: 8, type: "private" }, text: "/gad7" } },
    { update_id: 2, message: { message_id: 2, chat: { id: 8, type: "private" }, text: "3" } },
    { update_id: 3, message: { message_id: 3, chat: { id: 8, type: "private" }, text: "3" } },
    { update_id: 4, message: { message_id: 4, chat: { id: 8, type: "private" }, text: "3" } },
    { update_id: 5, message: { message_id: 5, chat: { id: 8, type: "private" }, text: "3" } },
    { update_id: 6, message: { message_id: 6, chat: { id: 8, type: "private" }, text: "3" } },
    { update_id: 7, message: { message_id: 7, chat: { id: 8, type: "private" }, text: "3" } },
    { update_id: 8, message: { message_id: 8, chat: { id: 8, type: "private" }, text: "3" } },
  ]);
  await first.runtime.pollOnce();
  assert.equal(first.store.lastResult(8, "gad7").score, 21);
  assert.equal(first.store.flush(), true);

  const second = runtimeHarness({ config: { dataFile: file, memoryOnly: false } });
  second.store.load();
  assert.equal(second.store.offset, 9);
  assert.equal(second.store.lastResult(8, "gad7").score, 21);
  assert.equal(second.store.history(8).length, 1);
});

// --------------------------------------------------------------- runner

const selected = tests.filter((entry) => entry.name.includes(filter));
let passed = 0;
const failures = [];

for (const entry of selected) {
  try {
    await entry.fn();
    passed++;
    console.log("ok   " + entry.name);
  } catch (error) {
    failures.push(entry.name);
    console.log("FAIL " + entry.name + "\n     " + String(error && error.stack ? error.stack : error)
      .split("\n").join("\n     "));
  }
}

console.log("");
console.log(passed + "/" + selected.length + " passed");
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* windows lag */ }
process.exit(failures.length ? 1 : 0);
