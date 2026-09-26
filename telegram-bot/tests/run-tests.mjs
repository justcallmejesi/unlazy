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

import {
  GAD7, INSTRUMENT_LIST, PCL5, PHQ9, SLEEP, STRESS, WELLBEING, bandOf, buildResult, interpretResult,
  itemContribution, scoreAnswers, severityOf, riskFlagged,
} from "../src/instruments.mjs";
import {
  MOOD_TAGS, PRACTICE_IDS, PRACTICES, SOS_BUTTON, isSosText, practicesFor,
} from "../src/selfhelp.mjs";
import { REPORT_COLORS, buildReport } from "../src/report.mjs";
import {
  CONSENT_VERSION, SUBSCRIPTION_PERIOD_SECONDS, activeShare, clientsOf, psyState,
} from "../src/psy.mjs";
import {
  applyPayment, checkPreCheckout, ensureTrial, entitlement, invoiceFor, isPro,
} from "../src/billing.mjs";
import { Store, MAX_NOTE_LENGTH, MAX_RESULTS_PER_USER } from "../src/store.mjs";
import { SessionManager } from "../src/session.mjs";
import {
  DAY_MS, MONDAY, WEDNESDAY, WEEK_MS, dueReminders, formatLocalDateTime, formatUtcOffset,
  isEuSummerTime, lastDueBefore, lastSundayUtc, nextDueAfter, offsetAt, parseTimeOfDay,
  parseUtcOffset, resolveSchedule, zoneOffsetMinutes,
} from "../src/reminders.mjs";
import { createRouter, parseAnswerCallback, parseCommand } from "../src/router.mjs";
import { TelegramClient, TelegramError, clipText, encodeBody, escapeHtml } from "../src/telegram.mjs";
import { DEFAULT_CRISIS_CONTACT, loadConfig, parseEnvFile } from "../src/config.mjs";
import { BotRuntime, buildBot } from "../bot.mjs";
import { MAX_PAYLOAD_BYTES, parseWebAppPayload } from "../src/webapp.mjs";
import { SHARED, isCurrent, staleCopies } from "../webapp/build.mjs";
import {
  ACCESS_BUTTON, MESSAGE_LIMIT, accessOffer, historyMessages, isAccessText, lastMessages, paywall, weeklyReminder,
} from "../src/texts.mjs";
import { freeLines, unlockedLines } from "../src/offer.mjs";
import { psyClientsList } from "../src/psytexts.mjs";

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
    contact: { username: "", name: "", role: "" },
    admin: { username: "", chatId: null },
    psy: { stars: 177, title: "Кабінет фахівця", description: "Клієнти і сповіщення. Щомісячна підписка." },
    botUsername: "test_bot",
    price: {
      stars: 100,
      trialDays: 7,
      title: "Повний доступ",
      description: "Шкали сну і стресу, повна історія та статистика.",
    },
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

// Most features are behind the one-time purchase now, so tests that exercise
// them either start the trial with /start or buy outright.
function grantAccess(store, chatId, nowMs) {
  applyPayment(store, chatId, { currency: "XTR", total_amount: 100, telegram_payment_charge_id: "ch_test" }, nowMs);
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

test("instruments: the sleep scale runs 0 to 28 and says what it is not", () => {
  assert.equal(SLEEP.items.length, 7);
  assert.equal(scoreAnswers(SLEEP, [4, 4, 4, 4, 4, 4, 4]), 28);
  assert.equal(scoreAnswers(SLEEP, [0, 0, 0, 0, 0, 0, 0]), 0);
  const bands = [[0, "спокійний"], [6, "спокійний"], [7, "легкі"], [13, "легкі"],
    [14, "помірні"], [20, "помірні"], [21, "виражені"], [28, "виражені"]];
  bands.forEach(([score, expected]) => assert.match(severityOf(SLEEP, score), new RegExp(expected)));
  assert.equal(SLEEP.cutoff, 14);
  assert.equal(SLEEP.paid, true);
  // Written for this bot, so it must never present itself as a screening tool.
  assert.match(SLEEP.caveat, /не валідований опитувальник/);
});

test("instruments: the stress scale counts its two positive items backwards", () => {
  assert.equal(STRESS.items.length, 8);
  const reversed = STRESS.items.map((item, index) => (item.reverse ? index : null)).filter((x) => x !== null);
  assert.deepEqual(reversed, [3, 5], "the two positively worded items");
  assert.equal(itemContribution(STRESS.items[0], 4), 4);
  assert.equal(itemContribution(STRESS.items[3], 4), 0, "coping contributes no strain");
  assert.equal(itemContribution(STRESS.items[3], 0), 4);

  // Agreeing with everything cannot max the score, which is the point.
  assert.equal(scoreAnswers(STRESS, new Array(8).fill(4)), 24);
  assert.equal(scoreAnswers(STRESS, new Array(8).fill(0)), 8);
  assert.equal(scoreAnswers(STRESS, [0, 0, 0, 4, 0, 4, 0, 0]), 0, "calmest possible");
  assert.equal(scoreAnswers(STRESS, [4, 4, 4, 0, 4, 0, 4, 4]), 32, "most strained possible");

  const bands = [[0, "низький"], [9, "низький"], [10, "помірний"], [19, "помірний"], [20, "високий"], [32, "високий"]];
  bands.forEach(([score, expected]) => assert.match(severityOf(STRESS, score), new RegExp(expected)));
  assert.match(STRESS.prompt, /останнього місяця/, "this scale asks about a month, not two weeks");
  assert.match(STRESS.caveat, /не валідований опитувальник/);
});

test("instruments: only the sleep and stress scales are paid", () => {
  assert.equal(GAD7.paid, undefined);
  assert.equal(PHQ9.paid, undefined);
  assert.equal(SLEEP.paid, true);
  assert.equal(STRESS.paid, true);
});

test("instruments: only the bot's own scales carry a caveat", () => {
  // The published instruments need no disclaimer, the bot's own ones do.
  assert.equal(GAD7.caveat, undefined);
  assert.equal(PHQ9.caveat, undefined);
  [SLEEP, STRESS].forEach((instrument) => {
    assert.match(instrument.caveat, /не валідований опитувальник/, instrument.id);
  });
});

test("instruments: every band describes its state, and bandOf agrees with severityOf", () => {
  INSTRUMENT_LIST.forEach((instrument) => {
    const seen = new Set();
    instrument.bands.forEach((band) => {
      assert.ok(typeof band.description === "string" && band.description.length > 20, instrument.id + " " + band.max);
      assert.match(band.description, /\.$/, "a description is a finished sentence");
      assert.doesNotMatch(band.description, /[\u2013\u2014]/, "no en or em dash in prose");
      assert.ok(!seen.has(band.description), "each band says something of its own");
      seen.add(band.description);
    });
    for (let score = 0; score <= instrument.maxScore; score += 1) {
      assert.equal(bandOf(instrument, score).label, severityOf(instrument, score), instrument.id + " " + score);
    }
    // A hand-edited score above the scale still lands in the top band.
    assert.equal(bandOf(instrument, instrument.maxScore + 5), instrument.bands[instrument.bands.length - 1]);
  });
});

test("results: the chat result describes the state, supports, then advises", () => {
  const h = harness();
  h.say("/start");
  const text = scoreText(completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]));
  const description = escapeHtml(bandOf(GAD7, 14).description);
  assert.match(text, /Оцінка: помірна тривога/);
  assert.ok(text.indexOf(description) !== -1, "the band description is in the result");
  assert.match(text, /<i>Не лякайтеся цього результату: він не означає, що з Вами щось не так\./);
  assert.match(text, /допомагають зрозуміти, чи варто звернутися по підтримку/);
  // Numbers, then what they mean, then that it is understandable, then what to do.
  const at = (needle) => text.indexOf(needle);
  assert.ok(at("Оцінка:") < at(description));
  assert.ok(at(description) < at("Не лякайтеся"));
  assert.ok(at("Не лякайтеся") < at("Бал вище порогу 10"));
  assert.ok(at("Бал вище порогу 10") < at("не замінює консультацію"));
  assert.doesNotMatch(text, /Валідизація|Spitzer|не валідований/, "a published scale has no caveat");
});

test("results: a score below the cutoff gets the calm support line", () => {
  const h = harness();
  h.say("/start");
  const text = scoreText(completeViaKeyboard(h, GAD7, [0, 1, 0, 1, 0, 0, 1]));
  assert.match(text, /Стан змінюється від тижня до тижня, і це нормально/);
  assert.doesNotMatch(text, /Не лякайтеся/);
  assert.match(text, /Бал нижче порогу 10\. Продовжуйте спостерігати/);
});

test("results: a marked risk item is never answered with reassurance", () => {
  const h = harness();
  h.say("/start");
  // A low total with the self-harm item marked. The minimal band would read
  // "almost no signs of depression" right above the crisis block.
  const text = scoreText(completeViaKeyboard(h, PHQ9, [0, 0, 0, 0, 0, 0, 0, 0, 1, 0]));
  assert.ok(text.indexOf(escapeHtml(bandOf(PHQ9, 1).description)) === -1, "no reassuring band text");
  assert.doesNotMatch(text, /Продовжуйте спостерігати/);
  assert.match(text, /одна з відповідей важливіша за суму/);
  assert.match(text, /цю відповідь варто обговорити з фахівцем, не чекаючи наступного тесту/);
  // The support line acknowledges the disclosure instead of calming it down.
  assert.match(text, /добре, що Ви відповіли чесно/);
  assert.doesNotMatch(text, /це нормально|Не лякайтеся/);
  assert.ok(text.indexOf("Важливо") !== -1, "the crisis block is present");
  assert.ok(text.indexOf("добре, що Ви відповіли чесно") < text.indexOf("Важливо"));
  assert.ok(text.indexOf("Важливо") < text.indexOf("не замінює консультацію"));
});

test("instruments: interpretResult keeps band wording unless risk outranks a low total", () => {
  const calm = buildResult(PHQ9, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], WED_NOON_UTC);
  assert.equal(interpretResult(PHQ9, calm).description, bandOf(PHQ9, 0).description);
  assert.match(interpretResult(PHQ9, calm).advice, /нижче порогу 10\. Продовжуйте спостерігати/);
  assert.match(interpretResult(PHQ9, calm).support, /це нормально/);
  const loaded = buildResult(GAD7, [2, 2, 2, 2, 2, 2, 2], WED_NOON_UTC);
  assert.match(interpretResult(GAD7, loaded).support, /^Не лякайтеся цього результату/);
  // Above the cutoff the band text stays, risk or not: it already names the weight.
  const heavy = buildResult(PHQ9, [3, 3, 3, 3, 3, 3, 3, 0, 1, 2], WED_NOON_UTC);
  assert.equal(heavy.risk, true);
  assert.equal(interpretResult(PHQ9, heavy).description, bandOf(PHQ9, heavy.score).description);
  assert.match(interpretResult(PHQ9, heavy).advice, /вище порогу 10/);
  assert.match(interpretResult(PHQ9, heavy).support, /відповіли чесно/, "risk outranks a high score too");
  const lowRisk = buildResult(PHQ9, [1, 0, 0, 1, 0, 0, 0, 0, 2, 0], WED_NOON_UTC);
  assert.equal(lowRisk.aboveCutoff, false);
  assert.doesNotMatch(interpretResult(PHQ9, lowRisk).description, /майже немає|не заважають/);
  assert.doesNotMatch(interpretResult(PHQ9, lowRisk).advice, /Продовжуйте спостерігати/);
  const riskSupport = interpretResult(PHQ9, lowRisk).support;
  assert.match(riskSupport, /не самотужки/, "it points towards people");
  assert.doesNotMatch(riskSupport, /нормальн|мине само|не лякайтеся/i, "never framed as harmless");
  [calm, loaded, lowRisk].forEach((result) => {
    const instrument = result.instrument === "gad7" ? GAD7 : PHQ9;
    assert.doesNotMatch(interpretResult(instrument, result).support, /[\u2013\u2014]/, "no en or em dash");
  });
});

// --------------------------------------------------------------- new scales

test("instruments: PCL-5 has twenty 0 to 4 items, an 80 point maximum and the cutoff of 33", () => {
  assert.equal(PCL5.items.length, 20);
  assert.equal(PCL5.maxScore, 80);
  assert.equal(scoreAnswers(PCL5, new Array(20).fill(4)), 80);
  assert.equal(PCL5.cutoff, 33);
  assert.equal(PCL5.paid, true);
  assert.equal(PCL5.caveat, undefined, "a published instrument carries no own-scale caveat");
  assert.equal(buildResult(PCL5, new Array(20).fill(0).map((_, i) => (i < 16 ? 2 : 0)), WED_NOON_UTC).aboveCutoff, false);
  const at = (score) => severityOf(PCL5, score);
  assert.equal(at(32), "прояви нижче порогу");
  assert.equal(at(33), "виражені прояви посттравматичного стресу");
  assert.match(PCL5.prompt, /останнього місяця/);
});

test("instruments: the wellbeing scale is the bot's own, and on it a low score is the worrying side", () => {
  assert.equal(WELLBEING.items.length, 6);
  assert.equal(WELLBEING.maxScore, 24);
  assert.equal(WELLBEING.higherIsBetter, true);
  assert.match(WELLBEING.caveat, /не валідований опитувальник/);
  // No item restates WHO-5, whose licence rules out a paid product.
  const who5 = /бадьор|спокійн|розслаб|свіж|відпочил|цікав/i;
  WELLBEING.items.forEach((item) => assert.doesNotMatch(item.text, who5, item.text));
  const low = buildResult(WELLBEING, [1, 1, 1, 1, 2, 2], WED_NOON_UTC);
  assert.equal(low.score, 8);
  assert.equal(low.aboveCutoff, true, "at the cutoff counts as crossing it");
  assert.match(interpretResult(WELLBEING, low).advice, /не вище порогу 8\. Це підстава обговорити/);
  assert.match(interpretResult(WELLBEING, low).support, /Не лякайтеся/);
  const good = buildResult(WELLBEING, [3, 3, 3, 3, 3, 3], WED_NOON_UTC);
  assert.equal(good.aboveCutoff, false);
  assert.match(interpretResult(WELLBEING, good).advice, /вище порогу 8\. Продовжуйте/);
  assert.equal(good.severity, "добре самопочуття");
});

test("router: a low wellbeing score offers the route to a person, like a high one elsewhere", () => {
  const h = harness({ config: { contact: { username: "helper_psy", name: "Олексій", role: "психолог" } } });
  h.say("/start");
  const finished = completeViaKeyboard(h, WELLBEING, [0, 1, 1, 1, 1, 1]);
  assert.match(scoreText(finished), /низьке самопочуття/);
  assert.ok(textsOf(finished).some((text) => /Можна не розбиратися з цим самому/.test(text)));
});

test("router: PCL-5 runs through the keyboard during the trial and locks after it", () => {
  const h = harness();
  h.say("/start");
  const finished = completeViaKeyboard(h, PCL5, new Array(20).fill(2));
  assert.match(scoreText(finished), /Бали: <b>40<\/b> з 80/);
  assert.match(scoreText(finished), /виражені прояви посттравматичного стресу/);
  h.clock.now += 15 * DAY_MS;
  assert.match(lastText(h.say("/pcl5")), /Повний доступ/);
});

// --------------------------------------------------------------- self-help

test("selfhelp: every scale and the mood check-in have two practices of their own", () => {
  INSTRUMENT_LIST.map((instrument) => instrument.id).concat(["mood"]).forEach((key) => {
    const practices = practicesFor(key);
    assert.equal(practices.length, 2, key);
    practices.forEach((practice) => assert.ok(PRACTICES[practice.id], key + " " + practice.id));
  });
  PRACTICE_IDS.forEach((id) => {
    const text = PRACTICES[id].title + " " + PRACTICES[id].steps.join(" ");
    assert.doesNotMatch(text, /[–—]/, "no en or em dash in " + id);
  });
});

test("selfhelp: every result carries a practices button, and it answers for that scale", () => {
  const h = harness();
  h.say("/start");
  const finished = completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  const scored = finished.find((action) => action.payload && /Бали:/.test(action.payload.text || ""));
  assert.deepEqual(scored.payload.reply_markup.inline_keyboard[0][0].callback_data, "p|gad7");
  const answer = h.tap("p|gad7");
  assert.match(lastText(answer), /Дихання 4-6/);
  assert.match(lastText(answer), /Заземлення 5-4-3-2-1/);
  // /selfhelp lists all of them, each one opens on its own.
  const menu = h.say("/selfhelp");
  const ids = menu[0].payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(ids, PRACTICE_IDS.map((id) => "pp|" + id));
  assert.match(lastText(h.tap("pp|sleep")), /Підготовка до сну/);
});

test("selfhelp: practices stay free after the trial", () => {
  const h = harness();
  h.say("/start");
  h.clock.now += 30 * DAY_MS;
  assert.match(lastText(h.tap("p|phq9")), /Маленька приємна справа/);
  assert.match(lastText(h.say("/selfhelp")), /Техніки самодопомоги/);
});

// --------------------------------------------------------------- SOS

test("sos: the button text and /sos answer with steps, emergency numbers first, then the contact", () => {
  const h = harness({ config: { contact: { username: "helper_psy", name: "Олексій", role: "психолог" } } });
  assert.ok(isSosText(SOS_BUTTON));
  assert.ok(isSosText("Мені зараз погано"));
  [h.say(SOS_BUTTON), h.say("/sos")].forEach((actions) => {
    const text = lastText(actions);
    assert.match(text, /Ви не самі/);
    assert.match(text, /Вдих носом на 4 рахунки/);
    assert.ok(text.indexOf("103 або 112") !== -1);
    assert.ok(text.indexOf("7333") !== -1, "the crisis contact list is included");
    assert.ok(text.indexOf("103 або 112") < text.indexOf("Олексій"), "emergency services come first");
    assert.equal(actions[0].payload.reply_markup.inline_keyboard[0][0].url, "https://t.me/helper_psy");
  });
});

test("sos: free after the trial, and it never ends up saved as a weekly note", () => {
  const h = harness();
  h.say("/start");
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(h.sessions.pendingNoteCount(), 1, "the note question is open");
  assert.match(lastText(h.say(SOS_BUTTON)), /Ви не самі/);
  assert.equal(h.sessions.pendingNoteCount(), 0, "SOS closes the note question");
  assert.equal(h.store.lastResult(777, "gad7").note, undefined);
  h.clock.now += 30 * DAY_MS;
  assert.match(lastText(h.say("/sos")), /Ви не самі/);
  // No contact configured: the steps and the numbers, and no personal button.
  assert.equal(h.say("/sos")[0].payload.reply_markup, undefined);
});

// --------------------------------------------------------------- mood

test("mood: one tap saves today's check-in, tags toggle, done shows the weekly average", () => {
  const h = harness();
  h.say("/start");
  const asked = h.say("/mood");
  assert.deepEqual(asked[0].payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => "m|" + n));
  const saved = h.tap("m|7");
  const edited = saved.find((action) => action.method === "editMessageText");
  assert.match(edited.payload.text, /Настрій сьогодні: <b>7<\/b> з 10\. Збережено/);
  // Wednesday noon UTC is 15:00 in Kyiv, same calendar day.
  assert.deepEqual(h.store.moods(777).map((entry) => [entry.date, entry.rating]), [["2026-09-16", 7]]);
  const tagged = h.tap("mt|2026-09-16|work");
  const markup = tagged.find((action) => action.method === "editMessageReplyMarkup").payload.reply_markup;
  assert.match(markup.inline_keyboard[0][1].text, /^✓ Робота/);
  assert.deepEqual(h.store.moods(777)[0].tags, ["work"]);
  h.tap("mt|2026-09-16|work");
  assert.deepEqual(h.store.moods(777)[0].tags, [], "a second tap clears the tag");
  h.tap("mt|2026-09-16|sleep");
  const done = h.tap("md|2026-09-16").find((action) => action.method === "editMessageText");
  assert.match(done.payload.text, /7<\/b> з 10 · Сон\./);
  assert.match(done.payload.text, /Середнє за останні 7 днів: 7,0/);
});

test("mood: a second check-in the same day replaces the first, a new day adds a row", () => {
  const h = harness();
  h.say("/start");
  h.tap("m|3");
  h.tap("m|6");
  assert.deepEqual(h.store.moods(777).map((entry) => entry.rating), [6]);
  h.clock.now += DAY_MS;
  h.tap("m|8");
  assert.deepEqual(h.store.moods(777).map((entry) => entry.date), ["2026-09-16", "2026-09-17"]);
  // 21:30 UTC is already the next day in Kyiv, UTC+3 in the fixture.
  h.clock.now = Date.parse("2026-09-17T21:30:00Z");
  h.tap("m|5");
  assert.equal(h.store.moods(777)[2].date, "2026-09-18");
});

test("mood: a low rating offers practices, a very low one points to SOS", () => {
  const h = harness();
  h.say("/start");
  const low = h.tap("m|4").find((action) => action.method === "editMessageText");
  assert.ok(low.payload.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "p|mood"));
  const crisis = h.tap("m|2").find((action) => action.method === "editMessageText");
  assert.match(crisis.payload.text, /\/sos/);
  const fine = h.tap("m|8").find((action) => action.method === "editMessageText");
  assert.ok(!fine.payload.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "p|mood"));
});

test("mood: part of the full access, locked after the trial", () => {
  const h = harness();
  h.say("/start");
  h.clock.now += 15 * DAY_MS;
  assert.match(lastText(h.say("/mood")), /Повний доступ/);
  assert.match(lastText(h.tap("m|7")), /Повний доступ/);
  assert.equal(h.store.moods(777).length, 0);
  grantAccess(h.store, 777, h.clock.now);
  h.tap("m|7");
  assert.equal(h.store.moods(777).length, 1);
});

test("mood: /export and /delete cover the check-ins too", () => {
  const h = harness();
  h.say("/start");
  h.tap("m|7");
  assert.match(lastText(h.say("/export")), /&quot;rating&quot;: 7|"rating": 7/);
  h.tap("del|yes");
  assert.equal(h.store.moods(777).length, 0);
});

test("mood: a hand-edited snapshot keeps only well-formed check-ins", () => {
  const dir = mkdtempSync(join(tmpdir(), "mood-"));
  try {
    const file = join(dir, "results.json");
    writeFileSync(file, JSON.stringify({
      version: 1, offset: 0, users: {
        5: {
          results: [],
          moods: [
            { date: "2026-09-10", rating: 5, tags: ["work", "bogus", "work"] },
            { date: "10.09.2026", rating: 5 },
            { date: "2026-09-11", rating: 11 },
            { date: "2026-09-09", rating: 1 },
          ],
        },
      },
    }));
    const store = new Store({ file });
    store.load();
    assert.deepEqual(store.moods(5).map((entry) => [entry.date, entry.rating, entry.tags]),
      [["2026-09-09", 1, []], ["2026-09-10", 5, ["work"]]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- report

function reportUser() {
  return {
    results: [
      { instrument: "gad7", score: 12, maxScore: 21, severity: "помірна тривога", completedAt: "2026-09-01T10:00:00Z",
        note: "<b>важкий</b> тиждень & безсоння" },
      { instrument: "gad7", score: 8, maxScore: 21, severity: "легка тривога", completedAt: "2026-09-15T10:00:00Z" },
      { instrument: "stress", score: 22, maxScore: 32, severity: "високий рівень напруження",
        completedAt: "2026-09-15T11:00:00Z" },
    ],
    moods: [{ date: "2026-09-14", rating: 4, tags: ["work"] }, { date: "2026-09-15", rating: 6, tags: ["work", "sleep"] }],
  };
}

test("report: one section per scale taken, notes only on request and always escaped", () => {
  const schedule = { zone: null, offsetMinutes: 180, weekday: 1, time: "19:00" };
  const withNotes = buildReport(reportUser(), { schedule, includeNotes: true, nowMs: WED_NOON_UTC });
  assert.match(withNotes, /^<!DOCTYPE html>/);
  assert.match(withNotes, /Звіт самоспостереження/);
  assert.match(withNotes, /Період: з 01\.09\.2026 по 15\.09\.2026/);
  assert.match(withNotes, />GAD-7: <span class="sub">скринінг тривоги/);
  assert.match(withNotes, /Останній результат: <b>8 з 21<\/b>, легка тривога/);
  assert.doesNotMatch(withNotes, />PHQ-9:/, "a scale never taken gets no section");
  assert.ok(withNotes.indexOf("&lt;b&gt;важкий&lt;/b&gt; тиждень &amp; безсоння") !== -1, "the note is escaped");
  assert.doesNotMatch(withNotes, /<b>важкий<\/b>/);
  assert.match(withNotes, /Це власна шкала самоспостереження/, "the own scale keeps its caveat");
  assert.match(withNotes, /Настрій: <span class="sub">/);
  assert.match(withNotes, /Що найчастіше впливало: Робота \(2\), Сон \(1\)/);
  assert.equal((withNotes.match(/<svg /g) || []).length, 3, "one chart per scale plus the mood chart");
  const plain = buildReport(reportUser(), { schedule, includeNotes: false, nowMs: WED_NOON_UTC });
  assert.doesNotMatch(plain, /важкий/);
  assert.doesNotMatch(plain, /Нотатка про тиждень/);
  assert.equal(buildReport({ results: [], moods: [] }, { schedule }), null);
});

test("report: every scale wears the same colour in the report as in the app", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "..", "webapp", "index.html"), "utf8");
  const light = html.slice(0, html.indexOf("@media (prefers-color-scheme: dark)"));
  Object.keys(REPORT_COLORS).forEach((id) => {
    assert.match(light, new RegExp("--series-" + id + ": " + REPORT_COLORS[id] + ";"), id);
  });
  INSTRUMENT_LIST.forEach((instrument) => assert.ok(REPORT_COLORS[instrument.id], instrument.id));
});

test("report: /report asks about notes, then sends an HTML document, free after the trial", () => {
  const h = harness();
  assert.match(lastText(h.say("/report")), /Поки немає даних/);
  h.say("/start");
  completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  h.say("тиждень <без> сну");
  h.clock.now += 30 * DAY_MS;
  const asked = h.say("/report");
  assert.deepEqual(asked[0].payload.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["rep|notes", "rep|plain"]);
  const sent = h.tap("rep|notes").find((action) => action.method === "sendDocument");
  assert.equal(sent.payload.chat_id, 777);
  assert.match(sent.payload.document.filename, /^report-\d{4}-\d{2}-\d{2}\.html$/);
  assert.match(sent.payload.document.contentType, /^text\/html/);
  assert.ok(sent.payload.document.content.indexOf("тиждень &lt;без&gt; сну") !== -1);
  const plain = h.tap("rep|plain").find((action) => action.method === "sendDocument");
  assert.equal(plain.payload.document.content.indexOf("без&gt; сну"), -1);
});

test("telegram: a document upload goes out as multipart with the file and JSON-encoded fields", async () => {
  const encoded = encodeBody({ chat_id: 5, reply_markup: { inline_keyboard: [] },
    document: { filename: "звіт report.html", contentType: "text/html; charset=utf-8", content: "<p>привіт</p>" } });
  assert.match(encoded.contentType, /^multipart\/form-data; boundary=/);
  const text = encoded.body.toString("utf8");
  assert.match(text, /name="document"; filename="_____report\.html"/, "the filename is reduced to safe ASCII");
  assert.match(text, /<p>привіт<\/p>/);
  assert.match(text, /name="reply_markup"\r\n\r\n\{"inline_keyboard":\[\]\}/);
  assert.equal(encodeBody({ a: 1 }).contentType, "application/json");

  let seen = null;
  const { server, port } = await startServer((request, response, body) => {
    seen = { type: request.headers["content-type"], length: Number(request.headers["content-length"]), body };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: { message_id: 3 } }));
  });
  try {
    const client = new TelegramClient({ token: FAKE_TOKEN, apiBase: "http://127.0.0.1:" + port });
    await client.call("sendDocument", { chat_id: 5, document: { filename: "r.html", content: "<p>x</p>" } });
    assert.match(seen.type, /^multipart\/form-data; boundary=----tgbot/);
    assert.equal(seen.length, Buffer.byteLength(seen.body, "utf8"));
    assert.match(seen.body, /filename="r\.html"/);
  } finally {
    await closeServer(server);
  }
});

// --------------------------------------------------------------- booking

const BOOKING_CONTACT = { username: "helper_psy", name: "Олексій", role: "психолог" };

function draftFrom(actions) {
  const button = actions.find((action) => action.payload && action.payload.reply_markup &&
    action.payload.reply_markup.inline_keyboard)?.payload.reply_markup.inline_keyboard[0][0];
  return { button, text: decodeURIComponent(button.url.split("?text=")[1]) };
}

test("booking: format, time, request and scores become a draft the person sends themselves", () => {
  const h = harness({ config: { contact: BOOKING_CONTACT } });
  h.say("/start");
  completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  const intro = h.say("/book");
  assert.equal(h.sessions.pendingNoteCount(), 0, "starting a booking closes the note question");
  assert.deepEqual(intro[0].payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data),
    ["b|f|online", "b|f|offline", "b|f|any"]);
  const time = h.tap("b|f|online").find((action) => action.method === "editMessageText");
  assert.match(time.payload.text, /Коли Вам зручно/);
  assert.match(lastText(h.tap("b|t|evening")), /З чим хотіли б попрацювати/);
  assert.match(lastText(h.say("тривога   перед\nсном")), /Додати до повідомлення Ваші останні результати/);
  const done = h.tap("b|s|yes");
  const { button, text } = draftFrom(done);
  assert.equal(button.text, "Надіслати заявку: Олексій");
  assert.match(button.url, /^https:\/\/t\.me\/helper_psy\?text=/);
  assert.match(text, /^Вітаю! Хочу записатися на консультацію\.\nФормат: онлайн\nЗручний час: вечір\nЗапит: тривога перед сном/);
  assert.match(text, /Мої останні результати:\nGAD-7 \(скринінг тривоги\): 14 з 21, помірна тривога/);
  assert.match(lastText(done), /надішлете самі/);
  assert.equal(h.sessions.pendingBookingCount(), 0);
  assert.equal(h.store.lastResult(777, "gad7").note, undefined, "the request is not a weekly note");
});

test("booking: without results the scores question is skipped, and the request can be skipped too", () => {
  const h = harness({ config: { contact: BOOKING_CONTACT } });
  h.say("/book");
  h.tap("b|f|any");
  h.tap("b|t|weekend");
  const { text } = draftFrom(h.tap("b|r|skip"));
  assert.equal(text, "Вітаю! Хочу записатися на консультацію.\nФормат: ще не знаю\nЗручний час: вихідні");
});

test("booking: no contact, stale taps and /cancel are handled", () => {
  assert.match(lastText(harness().say("/book")), /не налаштований/);
  const h = harness({ config: { contact: BOOKING_CONTACT } });
  assert.match(lastText(h.tap("b|t|day")), /Почати знову: \/book/);
  h.say("/book");
  // A time tap before the format is answered changes nothing.
  h.tap("b|t|day");
  assert.equal(h.sessions.booking(777, h.clock.now).step, "format");
  assert.match(lastText(h.say("/cancel")), /Запис перервано/);
  assert.equal(h.sessions.pendingBookingCount(), 0);
});

test("booking: the help offer carries a booking button", () => {
  const h = harness({ config: { contact: BOOKING_CONTACT } });
  h.say("/start");
  const finished = completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  const offer = finished.find((action) => /Можна не розбиратися/.test(action.payload.text || ""));
  assert.deepEqual(offer.payload.reply_markup.inline_keyboard[1], [{ text: "Записатися на консультацію", callback_data: "b|start" }]);
});

// --------------------------------------------------------------- app payloads

function appSend(h, data) {
  return h.router.handleUpdate({
    update_id: 30, message: { message_id: 1, chat: h.chat, web_app_data: { data: JSON.stringify(Object.assign({ v: 1 }, data)) } },
  });
}

test("webapp: mood, report and booking payloads are validated field by field", () => {
  assert.equal(parseWebAppPayload(JSON.stringify({ v: 1, type: "mood", rating: 7, tags: ["work", "work"] })).payload.tags.length, 1);
  assert.equal(parseWebAppPayload(JSON.stringify({ v: 1, type: "mood", rating: 11 })).ok, false);
  assert.equal(parseWebAppPayload(JSON.stringify({ v: 1, type: "mood", rating: 5, tags: ["hack"] })).ok, false);
  assert.equal(parseWebAppPayload(JSON.stringify({ v: 1, type: "report", notes: "yes" })).payload.includeNotes, false);
  assert.equal(parseWebAppPayload(JSON.stringify({ v: 1, type: "book", format: "online", time: "never" })).ok, false);
  const long = parseWebAppPayload(JSON.stringify({ v: 1, type: "book", format: "online", time: "day", request: "а ".repeat(400) }));
  assert.equal(long.payload.request.length, 300);
});

test("webapp: a mood from the app is stored, a report is sent, a booking becomes a draft", () => {
  const h = harness({ config: { contact: BOOKING_CONTACT } });
  h.say("/start");
  assert.match(lastText(appSend(h, { type: "mood", rating: 3, tags: ["news"] })), /3<\/b> з 10 · Новини/);
  assert.deepEqual(h.store.moods(777)[0].tags, ["news"]);
  const sent = appSend(h, { type: "report", notes: false });
  assert.equal(sent[0].method, "sendDocument");
  const { text } = draftFrom(appSend(h, { type: "book", format: "offline", time: "morning", request: "сон", scores: false }));
  assert.equal(text, "Вітаю! Хочу записатися на консультацію.\nФормат: очно\nЗручний час: ранок\nЗапит: сон");
  h.clock.now += 30 * DAY_MS;
  assert.match(lastText(appSend(h, { type: "mood", rating: 5 })), /Повний доступ/);
});

test("webapp: the launch URL carries the public contact for the SOS screen", () => {
  const h = harness({ config: { webappUrl: "https://example.pages.dev/", contact: BOOKING_CONTACT } });
  const url = h.say("/start")[0].payload.reply_markup.keyboard[0][0].web_app.url;
  assert.equal(url, "https://example.pages.dev/?pro=1&plan=trial&days=7&price=100&c=helper_psy&cn=" + encodeURIComponent("Олексій"));
});

// --------------------------------------------------------------- specialist mode

const OWNER = 5000;
const PSY = 6000;
const CLIENT = 777;

// A harness with an owner, a specialist and a client who can all talk to the
// same router. The owner is bound by username on their first message.
function psyHarness(overrides = {}) {
  const h = harness({ config: Object.assign({
    admin: { username: "owner_acc", chatId: null },
    contact: { username: "owner_acc", name: "Олексій", role: "психолог" },
  }, overrides.config || {}) });
  const as = (chatId, username, firstName) => ({
    say: (text) => h.router.handleUpdate({
      update_id: 1,
      message: { message_id: 10, chat: { id: chatId, type: "private" },
        from: { id: chatId, username, first_name: firstName }, text },
    }),
    tap: (data) => h.router.handleUpdate({
      update_id: 2,
      callback_query: { id: "cb", data, from: { id: chatId, username, first_name: firstName },
        message: { message_id: 11, chat: { id: chatId, type: "private" } } },
    }),
    pay: (payment) => h.router.handleUpdate({
      update_id: 3,
      message: { message_id: 12, chat: { id: chatId, type: "private" }, from: { id: chatId, username },
        successful_payment: payment },
    }),
  });
  return Object.assign(h, {
    owner: as(OWNER, "owner_acc", "Олексій"),
    psy: as(PSY, "anna_psy", "Анна"),
    client: as(CLIENT, "olya", "Оля"),
  });
}

function applyAs(actor, name, credentials) {
  actor.tap("py|apply");
  actor.say(name);
  actor.say(credentials);
  return actor.tap("py|terms");
}

function subscribe(h, chatId, expiresAtMs, first = true) {
  return h.psy.pay({
    currency: "XTR", total_amount: 177, invoice_payload: "psy-v1:" + chatId,
    telegram_payment_charge_id: first ? "sub_first" : "sub_renew_" + expiresAtMs,
    subscription_expiration_date: Math.floor(expiresAtMs / 1000), is_recurring: true, is_first_recurring: first,
  });
}

// Owner bound, specialist approved and subscribed, client linked with consent.
function linkedHarness() {
  const h = psyHarness();
  h.owner.say("/start");
  applyAs(h.psy, "Анна Коваль", "Психолог, КНУ, 5 років практики");
  h.owner.tap("ap|" + PSY);
  subscribe(h, PSY, h.clock.now + 30 * DAY_MS);
  const code = h.store.user(PSY).psy.inviteCode || (h.psy.say("/psy"), h.store.user(PSY).psy.inviteCode);
  h.client.say("/start c_" + code);
  h.client.tap("cs|yes|" + code);
  return Object.assign(h, { code });
}

test("psy: the state follows approval, subscription and the owner's free access", () => {
  const at = WED_NOON_UTC;
  assert.equal(psyState(null, at, false).kind, "none");
  assert.equal(psyState({ psy: { status: "pending" } }, at, false).kind, "pending");
  assert.equal(psyState({ psy: { status: "rejected" } }, at, false).active, false);
  assert.equal(psyState({ psy: { status: "approved", subscription: null } }, at, false).kind, "unsubscribed");
  const live = { psy: { status: "approved", subscription: { expiresAt: at + DAY_MS, canceled: true } } };
  assert.deepEqual([psyState(live, at, false).kind, psyState(live, at, false).canceled], ["subscribed", true]);
  assert.equal(psyState(live, at + 2 * DAY_MS, false).kind, "expired");
  assert.equal(psyState(null, at, true).kind, "admin", "the owner needs no subscription");
});

test("psy: the owner is bound by username once, and a later namesake gains nothing", () => {
  const h = psyHarness();
  assert.equal(h.store.meta.adminChatId, null);
  h.owner.say("/start");
  assert.equal(h.store.meta.adminChatId, OWNER);
  // Someone else takes the same username later: the chat id decides.
  const impostor = h.router.handleUpdate({ update_id: 9, message: { message_id: 1,
    chat: { id: 4242, type: "private" }, from: { id: 4242, username: "owner_acc" }, text: "/admin" } });
  assert.match(lastText(impostor), /лише для власника/);
  assert.match(lastText(h.owner.say("/admin")), /Нових заявок немає/);
  // A pinned id wins over any username.
  const pinned = psyHarness({ config: { admin: { username: "owner_acc", chatId: 9 } } });
  pinned.owner.say("/start");
  assert.equal(pinned.store.meta.adminChatId, null);
  assert.match(lastText(pinned.owner.say("/admin")), /лише для власника/);
});

test("psy: an application goes through name, credentials and terms, then waits for the owner", () => {
  const h = psyHarness();
  h.owner.say("/start");
  assert.match(lastText(h.psy.say("/psy")), /Кабінет фахівця[\s\S]*177 зірок на місяць/);
  assert.match(lastText(h.psy.tap("py|apply")), /крок 1 з 3/);
  assert.match(lastText(h.psy.say("Анна  Коваль")), /Крок 2 з 3/);
  const terms = h.psy.say("Психолог, КНУ, 5 років практики");
  assert.match(lastText(terms), /умови для фахівця/);
  assert.match(lastText(terms), /не передаєте ці дані третім особам/i);
  const submitted = h.psy.tap("py|terms");
  assert.match(textsOf(submitted)[0], /Заявку надіслано/);
  const toOwner = submitted.find((action) => action.payload.chat_id === OWNER);
  assert.match(toOwner.payload.text, /Нова заявка фахівця[\s\S]*Анна Коваль[\s\S]*@anna_psy/);
  assert.deepEqual(toOwner.payload.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["ap|" + PSY, "rj|" + PSY]);
  const profile = h.store.user(PSY).psy;
  assert.equal(profile.status, "pending");
  assert.equal(profile.name, "Анна Коваль");
  assert.equal(profile.termsVersion, "2026-09-v1");
  assert.match(lastText(h.psy.say("/psy")), /на розгляді/);
});

test("psy: only the owner decides, and the decision reaches the specialist", () => {
  const h = psyHarness();
  h.owner.say("/start");
  applyAs(h.psy, "Анна Коваль", "Психолог");
  assert.match(lastText(h.client.tap("ap|" + PSY)), /лише для власника/);
  assert.equal(h.store.user(PSY).psy.status, "pending");
  const approved = h.owner.tap("ap|" + PSY);
  assert.match(textsOf(approved)[0], /Схвалено: Анна Коваль/);
  const notice = approved.find((action) => action.payload.chat_id === PSY);
  assert.match(notice.payload.text, /Заявку схвалено/);
  assert.equal(notice.payload.reply_markup.inline_keyboard[0][0].callback_data, "py|sub");
  const other = psyHarness();
  other.owner.say("/start");
  applyAs(other.psy, "Хтось", "Без кваліфікації");
  const rejected = other.owner.tap("rj|" + PSY);
  assert.match(rejected.find((action) => action.payload.chat_id === PSY).payload.text, /відхилено/);
  assert.match(lastText(other.psy.say("/psy")), /відхилено/);
});

test("psy: the subscription is a 30-day Stars invoice link, and the link becomes a button", () => {
  const h = psyHarness();
  h.owner.say("/start");
  applyAs(h.psy, "Анна Коваль", "Психолог");
  assert.equal(h.psy.tap("py|sub").filter((a) => a.method === "createInvoiceLink").length, 0, "not before approval");
  h.owner.tap("ap|" + PSY);
  const invoice = h.psy.tap("py|sub").find((action) => action.method === "createInvoiceLink");
  assert.equal(invoice.payload.currency, "XTR");
  assert.equal(invoice.payload.subscription_period, SUBSCRIPTION_PERIOD_SECONDS);
  assert.equal(SUBSCRIPTION_PERIOD_SECONDS, 2592000);
  assert.equal(invoice.payload.payload, "psy-v1:" + PSY);
  assert.deepEqual(invoice.payload.prices, [{ label: "Кабінет фахівця", amount: 177 }]);
  const follow = invoice.then("https://t.me/$abc");
  assert.equal(follow[0].payload.reply_markup.inline_keyboard[0][0].url, "https://t.me/$abc");
  assert.deepEqual(invoice.then(undefined), [], "no link, no button");
});

test("psy: the pre-checkout accepts only an approved specialist paying for their own cabinet", () => {
  const h = psyHarness();
  h.owner.say("/start");
  applyAs(h.psy, "Анна Коваль", "Психолог");
  const query = (from, payload) => h.router.handleUpdate({ update_id: 4, pre_checkout_query: {
    id: "q1", from: { id: from }, currency: "XTR", total_amount: 177, invoice_payload: payload } })[0].payload;
  assert.equal(query(PSY, "psy-v1:" + PSY).ok, false, "pending specialists cannot pay yet");
  h.owner.tap("ap|" + PSY);
  assert.equal(query(PSY, "psy-v1:" + PSY).ok, true);
  assert.equal(query(CLIENT, "psy-v1:" + PSY).ok, false, "a forwarded link is refused");
  assert.equal(query(CLIENT, "pro-v1:" + CLIENT).ok, true, "the client purchase still works");
});

test("psy: the first payment opens the cabinet, renewals extend it, and neither unlocks client features", () => {
  const h = psyHarness();
  h.owner.say("/start");
  applyAs(h.psy, "Анна Коваль", "Психолог");
  h.owner.tap("ap|" + PSY);
  const first = subscribe(h, PSY, h.clock.now + 30 * DAY_MS);
  assert.match(lastText(first), /Кабінет відкрито/);
  const sub = h.store.user(PSY).psy.subscription;
  assert.equal(sub.firstChargeId, "sub_first");
  assert.equal(sub.expiresAt, Math.floor((h.clock.now + 30 * DAY_MS) / 1000) * 1000);
  assert.equal(h.store.user(PSY).pro, null, "the subscription is not the client purchase");
  h.clock.now += 29 * DAY_MS;
  const renewal = subscribe(h, PSY, h.clock.now + 31 * DAY_MS, false);
  assert.match(lastText(renewal), /продовжено/);
  assert.equal(h.store.user(PSY).psy.subscription.firstChargeId, "sub_first", "cancel needs the first charge");
  assert.equal(psyState(h.store.user(PSY), h.clock.now + 30 * DAY_MS, false).active, true);
});

test("psy: the dashboard shows the invite link, and a new link retires the old one", () => {
  const h = linkedHarness();
  const dash = lastText(h.psy.say("/psy"));
  assert.match(dash, new RegExp("https://t\\.me/test_bot\\?start=c_" + h.code));
  assert.match(dash, /Клієнтів зі згодою: 1/);
  const rotated = lastText(h.psy.say("/invite new"));
  const fresh = h.store.user(PSY).psy.inviteCode;
  assert.notEqual(fresh, h.code);
  assert.match(rotated, new RegExp("c_" + fresh));
  const stranger = h.router.handleUpdate({ update_id: 5, message: { message_id: 1, chat: { id: 31, type: "private" },
    from: { id: 31 }, text: "/start c_" + h.code } });
  assert.match(lastText(stranger), /недійсне або застаріло/);
  assert.equal(clientsOf(h.store, PSY).length, 1, "existing clients stay");
});

test("consent: the form says what is shared, what is not, why, how to revoke, and on what legal basis", () => {
  const h = psyHarness();
  h.owner.say("/start");
  applyAs(h.psy, "Анна Коваль", "Психолог");
  h.owner.tap("ap|" + PSY);
  subscribe(h, PSY, h.clock.now + 30 * DAY_MS);
  h.psy.say("/psy");
  const code = h.store.user(PSY).psy.inviteCode;
  const form = h.client.say("/start c_" + code);
  const text = form[0].payload.text;
  assert.match(text, /Згода на передачу даних фахівцю/);
  assert.match(text, /Хто:<\/b> Анна Коваль\. Фахівця перевірив власник бота/);
  assert.match(text, /Що бот збирає про Вас/);
  assert.match(text, /Що бачитиме фахівець/);
  assert.match(text, /Нотатки про тиждень фахівець бачитиме, лише якщо Ви окремо це дозволите/);
  assert.match(text, /Чого фахівець не бачитиме/);
  assert.match(text, /Як відкликати:<\/b> будь-коли, одним натисканням/);
  assert.match(text, /Закон України «Про захист персональних даних»/);
  assert.ok(text.indexOf(CONSENT_VERSION) !== -1);
  assert.deepEqual(form[0].payload.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
    ["cs|yes|" + code, "cs|no|" + code]);
  // Nothing is shared before the tap.
  assert.equal(activeShare(h.store.user(CLIENT), PSY), null);
  assert.match(lastText(h.client.tap("cs|no|" + code)), /фахівець нічого не бачить/);
  assert.equal(activeShare(h.store.user(CLIENT), PSY), null);
});

test("consent: agreeing records it with the version, asks about notes, and tells the specialist", () => {
  const h = linkedHarness();
  const share = activeShare(h.store.user(CLIENT), PSY);
  assert.equal(share.clientName, "Оля");
  assert.equal(share.version, CONSENT_VERSION);
  assert.equal(share.notes, false, "notes stay hidden until allowed");
  const done = h.client.tap("cn|" + PSY + "|1");
  assert.match(textsOf(done)[0], /Анна Коваль бачить Ваші результати і нотатки/);
  assert.equal(done[1].payload.reply_markup.inline_keyboard[0][0].callback_data, "rv|" + PSY);
  assert.equal(activeShare(h.store.user(CLIENT), PSY).notes, true);
  assert.ok(done.some((action) => action.payload && action.payload.chat_id === PSY && /нотатки/.test(action.payload.text)));
  assert.match(lastText(h.client.say("/start c_" + h.code)), /Ви вже ділитеся даними/);
});

test("consent: revoking is one tap, stops access at once and tells the specialist", () => {
  const h = linkedHarness();
  const privacy = h.client.say("/privacy");
  assert.match(privacy[0].payload.text, /Анна Коваль: з 16\.09\.2026, нотатки приховані/);
  const buttons = privacy[0].payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ["rv|" + PSY, "rn|" + PSY + "|1"]);
  const gone = h.client.tap("rv|" + PSY);
  assert.match(textsOf(gone)[0], /Згоду відкликано/);
  assert.ok(gone.some((action) => action.payload.chat_id === PSY && /відкликано/.test(action.payload.text)));
  assert.equal(activeShare(h.store.user(CLIENT), PSY), null);
  assert.equal(h.store.user(CLIENT).shares[0].revokedBy, "client", "the record of consent is kept");
  assert.match(lastText(h.psy.tap("cl|" + CLIENT)), /не надав згоди або відкликав/);
  assert.match(lastText(h.psy.say("/clients")), /Поки немає клієнтів/);
  assert.match(lastText(h.client.say("/privacy")), /не ділитеся даними з жодним фахівцем/);
});

test("psy: the client list and card show results, and notes only when the client allowed them", () => {
  const h = linkedHarness();
  completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  h.say("тиждень без сну");
  h.tap("m|4");
  const list = lastText(h.psy.say("/clients"));
  assert.match(list, /⚠️ Оля, з 16\.09\.2026: GAD-7 14\/21, настрій 4,0/);
  const card = h.psy.tap("cl|" + CLIENT);
  assert.match(textsOf(card)[0], /<b>GAD-7<\/b>: 14 з 21, помірна тривога/);
  assert.doesNotMatch(textsOf(card)[0], /тиждень без сну/, "notes are hidden by default");
  h.client.tap("rn|" + PSY + "|1");
  assert.match(textsOf(h.psy.tap("cl|" + CLIENT))[0], /тиждень без сну/);
  const report = h.psy.tap("clr|" + CLIENT).find((action) => action.method === "sendDocument");
  assert.equal(report.payload.chat_id, PSY);
  assert.match(report.payload.caption, /Звіт клієнта: Оля/);
  assert.ok(report.payload.document.content.indexOf("тиждень без сну") !== -1);
});

test("psy: nobody reads a client without that client's consent to them", () => {
  const h = linkedHarness();
  completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  // A second approved, subscribed specialist without consent.
  const other = 6100;
  h.store.updateUser(other, { psy: { status: "approved", name: "Інший", subscription: {
    firstChargeId: "x", lastChargeId: "x", expiresAt: h.clock.now + DAY_MS, stars: 177, since: null, canceled: false } } });
  const probe = (data) => h.router.handleUpdate({ update_id: 6, callback_query: { id: "p", data, from: { id: other },
    message: { message_id: 1, chat: { id: other, type: "private" } } } });
  assert.match(lastText(probe("cl|" + CLIENT)), /не надав згоди/);
  assert.equal(probe("clr|" + CLIENT).filter((action) => action.method === "sendDocument").length, 0);
  // The linked specialist loses access when the subscription lapses.
  h.clock.now += 40 * DAY_MS;
  assert.match(lastText(h.psy.tap("cl|" + CLIENT)), /частина кабінету фахівця/);
});

test("psy: a result past the cutoff or with the risk item marked alerts the specialist", () => {
  const h = linkedHarness();
  const high = completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  const alert = high.find((action) => action.payload && action.payload.chat_id === PSY);
  assert.match(alert.payload.text, /⚠️ <b>Оля<\/b>\nGAD-7: 14 з 21, помірна тривога\./);
  assert.equal(alert.payload.reply_markup.inline_keyboard[0][0].callback_data, "cl|" + CLIENT);
  const risky = completeViaKeyboard(h, PHQ9, [0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert.match(risky.find((action) => action.payload && action.payload.chat_id === PSY).payload.text, /питання 9 PHQ-9/);
  const calm = completeViaKeyboard(h, GAD7, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(calm.filter((action) => action.payload && action.payload.chat_id === PSY).length, 0, "calm results stay quiet");
  // No alerts once the subscription lapsed or the consent is gone.
  h.clock.now += 40 * DAY_MS;
  const lapsed = completeViaKeyboard(h, GAD7, [3, 3, 3, 3, 3, 3, 3]);
  assert.equal(lapsed.filter((action) => action.payload && action.payload.chat_id === PSY).length, 0);
});

test("psy: disconnecting a client ends the consent and tells the client", () => {
  const h = linkedHarness();
  const cut = h.psy.tap("cld|" + CLIENT);
  assert.match(textsOf(cut)[0], /Оля відключено/);
  assert.ok(cut.some((action) => action.payload.chat_id === CLIENT && /припинено/.test(action.payload.text)));
  assert.equal(activeShare(h.store.user(CLIENT), PSY), null);
  assert.equal(h.store.user(CLIENT).shares[0].revokedBy, "psy");
});

test("psy: /delete tells the specialist, and a specialist's /delete closes every consent to them", () => {
  const h = linkedHarness();
  const wiped = h.client.tap("del|yes");
  assert.ok(wiped.some((action) => action.payload.chat_id === PSY && /видалив свої дані/.test(action.payload.text)));
  const again = linkedHarness();
  const psyWiped = again.psy.tap("del|yes");
  assert.ok(psyWiped.some((action) => action.payload.chat_id === CLIENT && /більше не користується ботом/.test(action.payload.text)));
  assert.equal(activeShare(again.store.user(CLIENT), PSY), null);
});

test("psy: the owner's own cabinet is approved on the spot and free", () => {
  const h = psyHarness();
  h.owner.say("/start");
  assert.match(lastText(h.owner.say("/invite")), /частина кабінету фахівця/, "a profile comes first");
  const done = applyAs(h.owner, "Олексій", "Психолог");
  assert.match(lastText(done), /Ви власник бота, кабінет безкоштовний/);
  assert.equal(h.store.user(OWNER).psy.status, "approved");
  const code = h.store.user(OWNER).psy.inviteCode;
  h.client.say("/start c_" + code);
  h.client.tap("cs|yes|" + code);
  assert.equal(clientsOf(h.store, OWNER).length, 1);
  assert.match(lastText(h.owner.say("/clients")), /Оля/);
});

test("psy: turning auto-renewal off and on goes through editUserStarSubscription with the first charge", () => {
  const h = linkedHarness();
  const cancel = h.psy.tap("py|cancel").find((action) => action.method === "editUserStarSubscription");
  assert.deepEqual(cancel.payload, { user_id: PSY, telegram_payment_charge_id: "sub_first", is_canceled: true });
  assert.equal(h.store.user(PSY).psy.subscription.canceled, false, "nothing changes until Telegram confirms");
  assert.match(textsOf(cancel.then(true))[0], /Автопродовження вимкнено/);
  assert.equal(h.store.user(PSY).psy.subscription.canceled, true);
  assert.match(lastText(h.psy.say("/psy")), /автопродовження вимкнено/);
  const resume = h.psy.tap("py|resume").find((action) => action.method === "editUserStarSubscription");
  assert.equal(resume.payload.is_canceled, false);
  resume.then(true);
  assert.equal(h.store.user(PSY).psy.subscription.canceled, false);
});

test("psy: profiles, consents and the bound owner survive a restart; forged subscriptions do not", () => {
  const dir = mkdtempSync(join(tmpdir(), "psy-"));
  try {
    const file = join(dir, "results.json");
    const first = new Store({ file, writeDelayMs: 0 });
    first.setMeta({ adminChatId: OWNER });
    first.updateUser(PSY, { psy: { status: "approved", name: "Анна", inviteCode: "abcdefghij", subscription: {
      firstChargeId: "c1", lastChargeId: "c2", expiresAt: 123, stars: 177, since: "2026-09-01T00:00:00.000Z", canceled: true } } });
    first.updateUser(CLIENT, { shares: [{ psy: PSY, clientName: "Оля", grantedAt: "2026-09-02T00:00:00.000Z",
      version: CONSENT_VERSION, notes: true, revokedAt: null, revokedBy: null }] });
    first.updateUser(31, { psy: { status: "approved", subscription: { expiresAt: 9e15 } } });
    first.flush();
    const second = new Store({ file });
    second.load();
    assert.equal(second.meta.adminChatId, OWNER);
    assert.equal(second.user(PSY).psy.subscription.canceled, true);
    assert.equal(second.user(PSY).psy.inviteCode, "abcdefghij");
    assert.equal(activeShare(second.user(CLIENT), PSY).notes, true);
    assert.equal(second.user(31).psy.subscription, null, "no charge id, no subscription");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("psy: /export carries consents and the specialist profile", () => {
  const h = linkedHarness();
  assert.match(lastText(h.client.say("/export")), /shares/);
  assert.match(lastText(h.psy.say("/export")), /Анна Коваль/);
});

test("consent: a client who arrived by invite gets the greeting and the SOS keyboard after consenting", () => {
  const h = linkedHarness();
  const done = h.client.tap("cn|" + PSY + "|0");
  assert.match(textsOf(done)[0], /бачить Ваші результати, без нотаток/);
  assert.ok(textsOf(done).some((text) => /Я допомагаю регулярно відстежувати стан/.test(text)), "the greeting follows");
  assert.ok(done.some((action) => action.payload.reply_markup && action.payload.reply_markup.keyboard &&
    JSON.stringify(action.payload.reply_markup.keyboard).indexOf("Мені зараз погано") !== -1));
  assert.equal(done.filter((action) => action.payload.chat_id === PSY).length, 0, "no notes, no ping to the specialist");
});

test("psy: a client's Telegram name cannot break the specialist's messages", () => {
  const h = psyHarness();
  h.owner.say("/start");
  applyAs(h.psy, "Анна Коваль", "Психолог");
  h.owner.tap("ap|" + PSY);
  subscribe(h, PSY, h.clock.now + 30 * DAY_MS);
  h.psy.say("/psy");
  const code = h.store.user(PSY).psy.inviteCode;
  const evil = { id: 55, first_name: "<b>Оля</b> & <i>" };
  h.router.handleUpdate({ update_id: 7, callback_query: { id: "e", data: "cs|yes|" + code, from: evil,
    message: { message_id: 1, chat: { id: 55, type: "private" } } } });
  const list = lastText(h.psy.say("/clients"));
  assert.ok(list.indexOf("&lt;b&gt;Оля&lt;/b&gt; &amp; &lt;i&gt;") !== -1);
  assert.doesNotMatch(list, /<i>/);
});

test("paysupport: says what stays free after a refund, and how the specialist subscription ends", () => {
  const h = harness();
  const text = lastText(h.say("/paysupport"));
  assert.doesNotMatch(text, /щотижневе нагадування/, "the reminder is part of the paid access");
  assert.match(text, /Кабінет фахівця це окрема щомісячна підписка/);
});

test("runtime: an action's follow-up runs on its result, which is how the invoice link reaches the chat", async () => {
  const h = runtimeHarness();
  await h.runtime.runActions([{
    method: "createInvoiceLink",
    payload: { title: "x" },
    then: (link) => [{ method: "sendMessage", payload: { chat_id: 8, text: link } }],
  }]);
  assert.deepEqual(h.client.calls.map((call) => call.method), ["createInvoiceLink", "sendMessage"]);
  assert.equal(h.client.calls[1].payload.text, "https://t.me/$fakeinvoice");
});

test("config: the specialist price defaults to 300 Stars and stays under Telegram's cap", () => {
  const config = loadConfig({ BOT_TOKEN: FAKE_TOKEN }, { envFile: false });
  assert.equal(config.psy.stars, 300);
  assert.equal(config.admin.username, "justajsi", "the owner defaults to the contact");
  assert.equal(config.admin.chatId, null);
  assert.equal(loadConfig({ BOT_TOKEN: FAKE_TOKEN, ADMIN_CHAT_ID: "12345" }, { envFile: false }).admin.chatId, 12345);
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, PSY_PRICE_STARS: "20000" }, { envFile: false }), /10000/);
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, ADMIN_CHAT_ID: "abc" }, { envFile: false }), /ADMIN_CHAT_ID/);
});

// --------------------------------------------------------------- billing

test("billing: entitlement moves from none to trial to expired, and pro never expires", () => {
  const start = WED_NOON_UTC;
  assert.deepEqual(entitlement(null, start), { active: false, kind: "none", daysLeft: null });

  const onTrial = { trialEndsAt: start + 14 * 24 * 3600 * 1000 };
  assert.equal(entitlement(onTrial, start).kind, "trial");
  assert.equal(entitlement(onTrial, start).daysLeft, 14);
  assert.equal(entitlement(onTrial, start + 13.5 * 24 * 3600 * 1000).daysLeft, 1, "the last day still counts");
  assert.equal(entitlement(onTrial, onTrial.trialEndsAt).kind, "expired");
  assert.equal(entitlement(onTrial, onTrial.trialEndsAt).active, false);

  const paid = { trialEndsAt: start, pro: { chargeId: "ch_1", stars: 100, since: "x" } };
  assert.equal(entitlement(paid, start + 10 * 365 * 24 * 3600 * 1000).kind, "pro");
  assert.equal(isPro(paid), true);
  // A charge id is the only thing that grants access.
  assert.equal(isPro({ pro: { stars: 100 } }), false);
  assert.equal(isPro({ pro: true }), false);
});

test("billing: the trial starts once and cannot be restarted", () => {
  const store = new Store({ file: null });
  ensureTrial(store, 5, WED_NOON_UTC, 14);
  const first = store.user(5).trialEndsAt;
  assert.equal(first, WED_NOON_UTC + 14 * 24 * 3600 * 1000);
  // A month later, /start must not hand out another fortnight.
  ensureTrial(store, 5, WED_NOON_UTC + 30 * 24 * 3600 * 1000, 14);
  assert.equal(store.user(5).trialEndsAt, first);
  assert.equal(entitlement(store.user(5), WED_NOON_UTC + 30 * 24 * 3600 * 1000).kind, "expired");
});

test("billing: the invoice is in Stars with no provider token", () => {
  const invoice = invoiceFor(777, { stars: 100, title: "Повний доступ", description: "опис" });
  assert.equal(invoice.currency, "XTR");
  assert.equal(invoice.provider_token, undefined, "Stars invoices carry no provider token");
  assert.deepEqual(invoice.prices, [{ label: "Повний доступ", amount: 100 }]);
  assert.equal(invoice.payload, "pro-v1:777");
  assert.equal(invoice.chat_id, 777);
});

test("billing: pre-checkout accepts only this chat's Stars invoice", () => {
  assert.deepEqual(checkPreCheckout({ currency: "XTR", invoice_payload: "pro-v1:777" }, 777), { ok: true });
  assert.equal(checkPreCheckout({ currency: "XTR", invoice_payload: "pro-v1:555" }, 777).ok, false);
  assert.equal(checkPreCheckout({ currency: "UAH", invoice_payload: "pro-v1:777" }, 777).ok, false);
  assert.equal(checkPreCheckout(null, 777).ok, false);
});

test("billing: a payment is recorded only with the charge id a refund needs", () => {
  const store = new Store({ file: null });
  assert.equal(applyPayment(store, 9, { currency: "XTR", total_amount: 100 }, WED_NOON_UTC), null,
    "without a charge id there is nothing to refund later, so nothing is granted");
  assert.equal(applyPayment(store, 9, { currency: "UAH", total_amount: 100, telegram_payment_charge_id: "c" },
    WED_NOON_UTC), null);
  const record = applyPayment(store, 9,
    { currency: "XTR", total_amount: 100, telegram_payment_charge_id: "ch_abc" }, WED_NOON_UTC);
  assert.equal(record.chargeId, "ch_abc");
  assert.equal(record.stars, 100);
  assert.equal(isPro(store.user(9)), true);
});

test("billing: a snapshot keeps the trial and the purchase, and rejects a forged one", () => {
  const file = join(DIR, "billing.json");
  const first = new Store({ file, writeDelayMs: 1e9 });
  ensureTrial(first, 11, WED_NOON_UTC, 14);
  applyPayment(first, 11, { currency: "XTR", total_amount: 100, telegram_payment_charge_id: "ch_x" }, WED_NOON_UTC);
  first.flush();
  const second = new Store({ file });
  second.load();
  assert.equal(second.user(11).trialEndsAt, WED_NOON_UTC + 14 * 24 * 3600 * 1000);
  assert.equal(second.user(11).pro.chargeId, "ch_x");

  const forged = join(DIR, "forged.json");
  writeFileSync(forged, JSON.stringify({
    version: 1,
    users: { "12": { pro: true, trialEndsAt: "soon" }, "13": { pro: { stars: 100 } } },
  }));
  const third = new Store({ file: forged });
  third.load();
  assert.equal(third.user(12).pro, null, "pro: true is not a purchase");
  assert.equal(third.user(12).trialEndsAt, null);
  assert.equal(third.user(13).pro, null, "a purchase without a charge id is not a purchase");
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
  const text = historyMessages(store, 13, schedule).join("\n\n");
  assert.match(text, /<b>12<\/b>\/21 помірна тривога/);
  assert.doesNotMatch(text, /undefined/);
  assert.doesNotMatch(lastMessages(store, 13, schedule).join("\n"), /undefined/);
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
  // The greeting, then the reply keyboard that keeps "Мені зараз погано" in reach,
  // with the offer above it for anyone who has not bought.
  assert.deepEqual(methodsOf(actions), ["sendMessage", "sendMessage"]);
  assert.deepEqual(actions[1].payload.reply_markup.keyboard, [[{ text: "⭐ Повний доступ" }], [{ text: "🆘 Мені зараз погано" }]]);
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

test("router: a bare digit answers the current question and an out-of-range one is refused", () => {
  const h = harness();
  h.say("/gad7");
  const advanced = h.say("2");
  assert.match(lastText(advanced), /Питання 2 з 7/);
  assert.deepEqual(h.sessions.get(777, h.clock.now).answers, [2]);
  // 4 is a valid answer on the 0 to 4 scales, so on a 0 to 3 item it is named
  // as out of range rather than treated as unknown text.
  assert.match(lastText(h.say("4")), /від 0 до 3/);
  assert.match(lastText(h.say("5")), /Не зрозумів команду/);
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
  // History is part of the full access, so a fresh chat sees the offer first.
  assert.match(lastText(h.say("/results")), /Повний доступ/);
  h.say("/start");
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
  h.say("/start");
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
  h.say("/start");
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
  h.say("/start");
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
  pinned.say("/start");
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

// --------------------------------------------------------------- paywall in the chat

const DAY = 24 * 60 * 60 * 1000;

test("paywall: /start opens a trial and says how long it lasts", () => {
  const h = harness();
  const started = h.say("/start");
  assert.equal(h.store.user(777).trialEndsAt, WED_NOON_UTC + 7 * DAY);
  assert.match(started[0].payload.text, /Безкоштовний період: залишилося днів 7/);
  assert.match(started[0].payload.text, /100 зірок одноразово/);
  // The locked scales are marked in the keyboard, not hidden.
  const rows = started[0].payload.reply_markup.inline_keyboard;
  assert.deepEqual(rows[0].map((b) => b.callback_data), ["s|gad7", "s|phq9"]);
  assert.deepEqual(rows[1].map((b) => b.callback_data), ["s|sleep", "s|stress", "s|pcl5", "s|wellbeing"]);
  assert.doesNotMatch(rows[1][0].text, /🔒/, "nothing is locked during the trial");
});

test("paywall: the sleep and stress scales run during the trial and lock after it", () => {
  const h = harness();
  h.say("/start");
  assert.match(lastText(h.say("/sleep")), /Довго не могли заснути/);
  assert.equal(h.sessions.get(777, h.clock.now).instrumentId, "sleep");
  assert.match(lastText(h.say("/stress")), /Напруження/);

  // Two weeks and a minute later.
  h.clock.now += 7 * DAY + 60000;
  const locked = h.say("/sleep");
  assert.match(lastText(locked), /Безкоштовний період закінчився/);
  assert.match(lastText(locked), /100 зірок одноразово/);
  assert.equal(h.sessions.size(), 0, "no session is started behind the paywall");
  const button = locked[locked.length - 1].payload.reply_markup.inline_keyboard[0][0];
  assert.equal(button.callback_data, "pay|start");

  // The screening core stays free forever.
  assert.match(lastText(h.say("/gad7")), /Чуття|Відчуття нервозності/);
  assert.equal(h.sessions.get(777, h.clock.now).instrumentId, "gad7");
  // And the keyboard now shows the locks.
  const rows = h.say("/help")[0].payload.reply_markup.inline_keyboard;
  assert.match(rows[1][0].text, /🔒/);
});

test("paywall: /buy shows the offer and the button asks Telegram for an invoice", () => {
  const h = harness();
  const offer = h.say("/buy");
  assert.match(lastText(offer), /Повний доступ/);
  assert.match(lastText(offer), /Сон/);
  assert.match(lastText(offer), /назавжди безкоштовно/);

  const tapped = h.tap("pay|start");
  assert.deepEqual(methodsOf(tapped), ["answerCallbackQuery", "sendInvoice"]);
  const invoice = tapped[1].payload;
  assert.equal(invoice.currency, "XTR");
  assert.deepEqual(invoice.prices, [{ label: "Повний доступ", amount: 100 }]);
  assert.equal(invoice.payload, "pro-v1:777");
});

test("paywall: the pre-checkout query is answered, and a foreign payload is refused", () => {
  const h = harness();
  const ok = h.router.handleUpdate({
    update_id: 20,
    pre_checkout_query: { id: "pcq1", from: { id: 777 }, currency: "XTR", total_amount: 100, invoice_payload: "pro-v1:777" },
  });
  assert.deepEqual(methodsOf(ok), ["answerPreCheckoutQuery"]);
  assert.equal(ok[0].payload.ok, true);
  assert.equal(ok[0].payload.pre_checkout_query_id, "pcq1");

  const foreign = h.router.handleUpdate({
    update_id: 21,
    pre_checkout_query: { id: "pcq2", from: { id: 777 }, currency: "XTR", total_amount: 100, invoice_payload: "pro-v1:999" },
  });
  assert.equal(foreign[0].payload.ok, false);
  assert.match(foreign[0].payload.error_message, /Спробуйте ще раз/);
});

test("paywall: a successful payment unlocks everything for good", () => {
  const h = harness();
  h.say("/start");
  h.clock.now += 20 * DAY;
  assert.match(lastText(h.say("/sleep")), /Безкоштовний період закінчився/);

  const paid = h.router.handleUpdate({
    update_id: 22,
    message: {
      message_id: 1,
      chat: h.chat,
      successful_payment: {
        currency: "XTR",
        total_amount: 100,
        invoice_payload: "pro-v1:777",
        telegram_payment_charge_id: "ch_live_1",
      },
    },
  });
  assert.match(lastText(paid), /повний доступ відкрито назавжди/);
  assert.equal(h.store.user(777).pro.chargeId, "ch_live_1");
  assert.equal(h.router.access(777).kind, "pro");

  assert.match(lastText(h.say("/sleep")), /Довго не могли заснути/);
  h.clock.now += 5 * 365 * DAY;
  assert.equal(h.router.access(777).active, true, "a one-time purchase does not lapse");
  const bought = h.say("/buy");
  assert.match(lastText(bought), /Відкрито назавжди/);
  assert.equal(bought[0].payload.reply_markup, undefined, "no pay button once bought");
});

test("paywall: history, settings and reminders are locked, the tests are not", () => {
  const h = harness();
  h.say("/start");
  for (let run = 0; run < 12; run++) {
    h.store.addResult(777, buildResult(GAD7, [1, 1, 1, 1, 1, 1, 1], WED_NOON_UTC - run * WEEK_MS));
  }
  h.clock.now += 20 * DAY;

  ["/results", "/last", "/remind", "/tz +3"].forEach((command) => {
    assert.match(lastText(h.say(command)), /Повний доступ/, command + " is behind the purchase");
  });
  assert.match(lastText(h.tap("h|all")), /Повний доступ/);
  assert.match(lastText(h.tap("r|status")), /Повний доступ/);
  // The two screening tests keep working, which is the whole free tier.
  assert.match(lastText(h.say("/gad7")), /Відчуття нервозності/);
  const finished = completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  assert.match(scoreText(finished), /Бали: <b>7<\/b> з 21/);
  assert.equal(h.store.history(777, "gad7").length, 13, "a free result is still stored");
  // And so do the data commands: access to one's own data is not a feature.
  // Thirteen runs outgrow a message, so the export comes whole as a file.
  const exported = h.say("/export");
  assert.equal(exported[0].method, "sendDocument");
  assert.equal(JSON.parse(exported[0].payload.document.content).results.length, 13);

  grantAccess(h.store, 777, h.clock.now);
  const full = lastText(h.say("/results"));
  assert.match(full, /показані останні 10 з 13/);
  assert.match(lastText(h.say("/remind")), /Нагадування/);
});

test("paywall: a lapsed chat gets no weekly reminder", async () => {
  const h = runtimeHarness();
  ensureTrial(h.store, 8, MONDAY_SLOT_UTC - 20 * DAY, 14);
  h.store.updateUser(8, { remindersEnabled: true });
  // The trial ran out six days before this slot.
  assert.deepEqual(await h.runtime.sweepReminders(JUST_AFTER_SLOT), []);
  assert.equal(h.client.calls.length, 0);
  assert.equal(h.store.user(8).lastRemindedAt, 0, "the slot is left untouched, not marked as sent");

  grantAccess(h.store, 8, JUST_AFTER_SLOT);
  assert.deepEqual(await h.runtime.sweepReminders(JUST_AFTER_SLOT), [8]);
});

test("paywall: /start promises the reminder only while access lasts", () => {
  const h = harness();
  assert.match(h.say("/start")[0].payload.text, /я нагадаю пройти тести знову/);
  h.clock.now += 20 * DAY;
  const lapsed = h.say("/start")[0].payload.text;
  assert.match(lapsed, /входять у повний доступ/);
  assert.doesNotMatch(lapsed, /я нагадаю пройти тести знову/);
});

test("paywall: /paysupport explains the refund and what stays free", () => {
  const h = harness();
  const text = lastText(h.say("/paysupport"));
  assert.match(text, /одноразова покупка/);
  assert.match(text, /Повернення можливе протягом 14 днів/);
  assert.match(text, /результати залишаться/);
  assert.match(text, /GAD-7 і PHQ-9/);
  assert.doesNotMatch(text, /напишіть тут/, "the bot forwards nothing, so a request typed here reaches no one");
});

test("paywall: /paysupport routes the refund request to the owner with the charge id", () => {
  const h = harness({ config: { admin: { username: "owner_acc", chatId: null } } });
  h.say("/start");
  grantAccess(h.store, 777, h.clock.now);
  const reply = h.say("/paysupport");
  const action = reply[reply.length - 1];
  assert.match(action.payload.text, /напишіть @owner_acc кнопкою нижче/);
  const url = action.payload.reply_markup.inline_keyboard[0][0].url;
  assert.ok(url.startsWith("https://t.me/owner_acc?text="));
  const draft = decodeURIComponent(url.split("?text=")[1]);
  assert.match(draft, /@test_bot/);
  assert.match(draft, /Мій id: 777\./);
  assert.match(draft, /повний доступ ch_test/, "refundStarPayment needs the user id and this charge id");

  const unpaid = harness({ config: { admin: { username: "owner_acc", chatId: null } } });
  const none = unpaid.say("/paysupport");
  assert.match(decodeURIComponent(none[0].payload.reply_markup.inline_keyboard[0][0].url), /Платежів поки немає/);
  assert.equal(harness().say("/paysupport")[0].payload.reply_markup, undefined, "no owner, no dead link");
});

test("paywall: a second charge that slips past the check keeps the first and asks for a refund", () => {
  const h = harness();
  h.say("/start");
  grantAccess(h.store, 777, h.clock.now);
  const paid = h.router.handleUpdate({
    update_id: 23,
    message: {
      message_id: 1,
      chat: h.chat,
      successful_payment: {
        currency: "XTR", total_amount: 100, invoice_payload: "pro-v1:777", telegram_payment_charge_id: "ch_second",
      },
    },
  });
  assert.equal(h.store.user(777).pro.chargeId, "ch_test", "the first purchase stays on record");
  assert.match(lastText(paid), /цей платіж зайвий/);
  assert.match(lastText(paid), /<code>ch_second<\/code>/);
});

test("paywall: the window is told the state, and the bot still refuses a locked result", () => {
  const h = harness({ config: { webappUrl: "https://example.pages.dev/" } });
  h.say("/start");
  assert.equal(h.say("/app")[0].payload.reply_markup.keyboard[0][0].web_app.url,
    "https://example.pages.dev/?pro=1&plan=trial&days=7&price=100");
  h.clock.now += 20 * DAY;
  assert.equal(h.say("/app")[0].payload.reply_markup.keyboard[0][0].web_app.url,
    "https://example.pages.dev/?pro=0&plan=expired&price=100");

  // An edited client can still submit a locked scale: the bot is the gate.
  const submitted = h.router.handleUpdate({
    update_id: 23,
    message: {
      message_id: 1,
      chat: h.chat,
      web_app_data: {
        data: JSON.stringify({ v: 1, type: "result", instrument: "sleep", answers: [4, 4, 4, 4, 4, 4, 4] }),
      },
    },
  });
  assert.match(lastText(submitted), /Повний доступ/);
  assert.equal(h.store.history(777, "sleep").length, 0, "nothing is stored behind the paywall");

  applyPayment(h.store, 777, { currency: "XTR", total_amount: 100, telegram_payment_charge_id: "ch_3" }, h.clock.now);
  h.router.handleUpdate({
    update_id: 24,
    message: {
      message_id: 1,
      chat: h.chat,
      web_app_data: {
        data: JSON.stringify({ v: 1, type: "result", instrument: "sleep", answers: [4, 4, 4, 4, 4, 4, 4] }),
      },
    },
  });
  assert.equal(h.store.lastResult(777, "sleep").score, 28);
});

test("paywall: a full stress run through the keyboard scores the reversed items", () => {
  const h = harness();
  h.say("/start");
  const finished = completeViaKeyboard(h, STRESS, [4, 4, 4, 0, 4, 0, 4, 4]);
  assert.match(scoreText(finished), /Бали: <b>32<\/b> з 32/);
  assert.match(scoreText(finished), /високий рівень напруження/);
  assert.match(scoreText(finished), /не валідований опитувальник/);
  assert.match(scoreText(finished), /Не лякайтеся цього результату/);
  assert.match(scoreText(finished), /Напруження високе і тримається довго/);
  assert.equal(h.store.lastResult(777, "stress").score, 32);
});

// --------------------------------------------------------------- help offer

const CONTACT = { username: "helper_psy", name: "Олексій", role: "психолог" };

test("contact: a score above the cutoff offers a ready message with the scores in it", () => {
  const h = harness({ config: { contact: CONTACT } });
  h.say("/start");
  const finished = completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  const offer = textsOf(finished).find((text) => text.indexOf("Можна не розбиратися") !== -1);
  assert.ok(offer, "the offer follows a score above the cutoff");
  assert.match(offer, /Олексій/);
  assert.match(offer, /психолог/);
  assert.match(offer, /GAD-7 \(скринінг тривоги\): 14 з 21/);
  assert.match(offer, /помірна тривога/);

  // The order matters: the score first, the offer next, the open question last.
  const order = textsOf(finished);
  assert.ok(order.findIndex((x) => x.indexOf("Бали:") !== -1) <
    order.findIndex((x) => x.indexOf("Можна не розбиратися") !== -1));
  assert.ok(order.findIndex((x) => x.indexOf("Можна не розбиратися") !== -1) <
    order.findIndex((x) => x.indexOf("вільними словами") !== -1));

  const button = finished.find((action) => {
    const rows = action.payload && action.payload.reply_markup && action.payload.reply_markup.inline_keyboard;
    if (!Array.isArray(rows) || !rows.length || !rows[0].length) return false;
    return String(rows[0][0].url || "").indexOf("t.me/helper_psy") !== -1;
  });
  assert.ok(button, "a link to the account with the draft attached");
  const url = button.payload.reply_markup.inline_keyboard[0][0].url;
  assert.match(url, /^https:\/\/t\.me\/helper_psy\?text=/);
  // Telegram fills the box from ?text= and the person presses send.
  const draft = decodeURIComponent(url.slice(url.indexOf("?text=") + 6));
  assert.match(draft, /хотів би звернутися за допомогою/);
  assert.match(draft, /GAD-7 \(скринінг тривоги\): 14 з 21/);
  assert.ok(url.indexOf(" ") === -1, "the draft is encoded, not raw");
});

test("contact: a score below the cutoff is left alone", () => {
  const h = harness({ config: { contact: CONTACT } });
  h.say("/start");
  const finished = completeViaKeyboard(h, GAD7, [0, 0, 0, 1, 0, 0, 0]);
  assert.equal(textsOf(finished).find((text) => text.indexOf("Можна не розбиратися") !== -1), undefined);
});

test("contact: marked risk offers help even when the total is low, after the crisis block", () => {
  const h = harness({ config: { contact: CONTACT } });
  h.say("/start");
  const finished = completeViaKeyboard(h, PHQ9, [0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
  const score = scoreText(finished);
  assert.match(score, /Бали: <b>1<\/b> з 27/, "below every cutoff");
  // Emergency services stay inside the result, ahead of any private contact.
  assert.match(score, /7333/);
  const order = textsOf(finished);
  assert.ok(order.findIndex((x) => x.indexOf("7333") !== -1) <
    order.findIndex((x) => x.indexOf("Можна не розбиратися") !== -1),
  "the crisis lines come before the personal contact");
});

test("contact: the draft carries every scale the person has taken", () => {
  const h = harness({ config: { contact: CONTACT } });
  h.say("/start");
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  h.say("/skip");
  const finished = completeViaKeyboard(h, STRESS, [4, 4, 4, 0, 4, 0, 4, 4]);
  const offer = textsOf(finished).find((text) => text.indexOf("Можна не розбиратися") !== -1);
  assert.match(offer, /GAD-7/);
  assert.match(offer, /Стрес/);
  assert.match(offer, /32 з 32/);
});

test("contact: /contact works any time and stays free after the trial", () => {
  const h = harness({ config: { contact: CONTACT } });
  h.say("/start");
  completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  h.clock.now += 30 * DAY;
  assert.match(lastText(h.say("/results")), /Повний доступ/, "history is locked by now");
  const offer = lastText(h.say("/contact"));
  assert.match(offer, /Можна не розбиратися/);
  assert.match(offer, /GAD-7 \(скринінг тривоги\): 14 з 21/);
});

test("contact: with only a username the button names the account", () => {
  const h = harness({ config: { contact: { username: "justajsi", name: "", role: "" } } });
  h.say("/start");
  const finished = completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  const offer = finished.find((action) => {
    const rows = action.payload && action.payload.reply_markup && action.payload.reply_markup.inline_keyboard;
    return Array.isArray(rows) && rows.length && rows[0].length &&
      String(rows[0][0].url || "").indexOf("t.me/justajsi") !== -1;
  });
  assert.ok(offer);
  assert.equal(offer.payload.reply_markup.inline_keyboard[0][0].text, "Написати @justajsi");
  assert.match(offer.payload.text, /@justajsi/);
  assert.doesNotMatch(offer.payload.text, /\(\)/, "no empty parentheses where the role would go");
});

test("contact: with no username configured nothing is offered", () => {
  const h = harness();
  h.say("/start");
  const finished = completeViaKeyboard(h, GAD7, [3, 3, 3, 3, 3, 3, 3]);
  assert.equal(textsOf(finished).find((text) => text.indexOf("Можна не розбиратися") !== -1), undefined);
  assert.match(lastText(h.say("/contact")), /не налаштований/);
});

test("contact: the name and role default to the owner's details", () => {
  const config = loadConfig({ BOT_TOKEN: FAKE_TOKEN }, { envFile: false });
  assert.deepEqual(config.contact, { username: "justajsi", name: "Олексій", role: "психолог" });
  // Each part can be dropped on its own without switching the offer off.
  const nameless = loadConfig({ BOT_TOKEN: FAKE_TOKEN, CONTACT_NAME: "" }, { envFile: false });
  assert.equal(nameless.contact.name, "");
  assert.equal(nameless.contact.username, "justajsi");
  const roleless = loadConfig({ BOT_TOKEN: FAKE_TOKEN, CONTACT_ROLE: "" }, { envFile: false });
  assert.equal(roleless.contact.role, "");
  assert.equal(loadConfig({ BOT_TOKEN: FAKE_TOKEN, CONTACT_ROLE: "коуч" }, { envFile: false }).contact.role,
    "коуч");
});

test("contact: the offer never has to decline the name", () => {
  const h = harness({ config: { contact: { username: "justajsi", name: "Олексій", role: "психолог" } } });
  h.say("/start");
  const finished = completeViaKeyboard(h, GAD7, [2, 2, 2, 2, 2, 2, 2]);
  const offer = textsOf(finished).find((text) => text.indexOf("Можна не розбиратися") !== -1);
  // "напишіть Олексій" would be the wrong case, so the name follows a colon.
  assert.match(offer, /ось контакт: Олексій \(психолог\)/);
  assert.doesNotMatch(offer, /напишіть Олексій/);
  const button = finished.find((action) => {
    const rows = action.payload && action.payload.reply_markup && action.payload.reply_markup.inline_keyboard;
    return Array.isArray(rows) && rows.length && rows[0].length && rows[0][0].url;
  });
  assert.equal(button.payload.reply_markup.inline_keyboard[0][0].text, "Написати: Олексій");
});

test("contact: the username defaults to the owner's account and is validated", () => {
  const good = loadConfig({ BOT_TOKEN: FAKE_TOKEN, CONTACT_USERNAME: "@helper_psy" }, { envFile: false });
  assert.equal(good.contact.username, "helper_psy", "a leading at sign is stripped");
  // Unset means the owner's account, so the offer works out of the box.
  assert.equal(loadConfig({ BOT_TOKEN: FAKE_TOKEN }, { envFile: false }).contact.username, "justajsi");
  // An explicitly empty value is the off switch, and must not fall back.
  assert.equal(loadConfig({ BOT_TOKEN: FAKE_TOKEN, CONTACT_USERNAME: "" }, { envFile: false }).contact.username, "");
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, CONTACT_USERNAME: "ab" }, { envFile: false }),
    /must be a Telegram username/);
  assert.throws(() => loadConfig({ BOT_TOKEN: FAKE_TOKEN, CONTACT_USERNAME: "bad name!" }, { envFile: false }),
    /must be a Telegram username/);
});

// --------------------------------------------------------------- mini app

test("webapp: the app's copies of the shared definitions are identical to the bot's", () => {
  assert.deepEqual(staleCopies(), [], "run node telegram-bot/webapp/build.mjs after changing a shared file in src/");
  assert.equal(isCurrent(), true);
  assert.deepEqual(SHARED.map((entry) => entry.name), ["instruments.mjs", "selfhelp.mjs", "offer.mjs"]);
  SHARED.forEach((entry) => assert.equal(readFileSync(entry.copy, "utf8"), readFileSync(entry.source, "utf8")));
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

test("webapp: the result screen describes, supports, and keeps the own-scale caveat after any crisis", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "..", "webapp", "index.html"), "utf8");
  const app = readFileSync(join(here, "..", "webapp", "app.js"), "utf8");
  ["result-description", "result-support", "result-cutoff", "result-crisis", "result-caveat"].forEach((id) => {
    assert.match(html, new RegExp('id="' + id + '"'), id);
  });
  const at = (id) => html.indexOf('id="' + id + '"');
  assert.ok(at("result-description") < at("result-support"));
  assert.ok(at("result-support") < at("result-cutoff"));
  assert.ok(at("result-crisis") < at("result-caveat"), "the crisis callout comes before the fine print");
  assert.match(app, /\$\("result-description"\)\.textContent = meaning\.description/);
  assert.match(app, /\$\("result-support"\)\.textContent = meaning\.support/);
  assert.match(app, /\$\("result-cutoff"\)\.textContent = meaning\.advice/);
  // Until now the app never showed the own-scale caveat at all.
  assert.match(app, /caveat\.hidden = !instrument\.caveat/);
  // The texts come from the shared definitions, never restated in the app.
  assert.doesNotMatch(app, /майже не турбує|Не лякайтеся|не валідований|Бал вище порогу/);
});

test("webapp: the new screens exist, SOS comes first, and their texts come from the shared module", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "..", "webapp", "index.html"), "utf8");
  const app = readFileSync(join(here, "..", "webapp", "app.js"), "utf8");
  ["sos", "mood", "practices", "report", "booking"].forEach((id) => {
    assert.match(html, new RegExp('<div id="' + id + '" class="screen">'), id);
  });
  const menu = html.slice(html.indexOf('id="home-menu"'));
  assert.ok(menu.indexOf('data-go="sos"') < menu.indexOf('id="scale-anchor"'), "SOS sits above the scales");
  assert.match(html, /\[hidden\] \{ display: none !important; \}/, "hidden cards stay hidden despite .menu-item");
  assert.match(html, /<button class="menu-item" data-go="booking" id="booking-card" hidden>/);
  assert.match(app, /from "\.\/selfhelp\.mjs"/);
  assert.doesNotMatch(app, /Дихання 4-6|Заземлення|Ви не самі|Ще не знаю/, "the app restates no shared text");
  // The contact from the launch URL is checked before it becomes a link.
  assert.match(app, /\/\^\[A-Za-z0-9_\]\{4,32\}\$\/\.test\(PARAMS\.get\("c"\)/);
  // Emergency numbers are in the page itself, so the screen works offline of the bot.
  assert.match(html, /href="tel:103"/);
  assert.match(html, /href="tel:7333"/);
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
  // A result from the app gets the same description and validation note.
  assert.match(scoreText(actions), /Тривога турбує більшу частину часу/);
  assert.match(scoreText(actions), /Не лякайтеся цього результату/);
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
  h.say("/start");
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
  // The lock state rides along in the query string as a hint for the window.
  assert.equal(keyboard[0][0].web_app.url, "https://example.pages.dev/?pro=1&plan=trial&days=7&price=100");
  assert.match(keyboard[0][0].text, /Відкрити застосунок/);
  assert.deepEqual(keyboard[1], [{ text: "⭐ Повний доступ" }], "the offer sits under the app button");
  assert.deepEqual(keyboard[2], [{ text: "🆘 Мені зараз погано" }], "and SOS stays the bottom row, on its own");
  assert.equal(started[0].payload.reply_markup.is_persistent, true);
  assert.match(lastText(started), /вікно поверх чату/);
  assert.match(lastText(withApp.say("/app")), /Відкрити застосунок/);

  const chatOnly = harness();
  const plain = chatOnly.say("/start");
  assert.equal(plain.length, 2);
  assert.ok(plain[0].payload.reply_markup.inline_keyboard, "the chat flow keeps its inline buttons");
  assert.deepEqual(plain[1].payload.reply_markup.keyboard, [[{ text: "⭐ Повний доступ" }], [{ text: "🆘 Мені зараз погано" }]]);
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
  ["BOT_TOKEN", "DATA_FILE", "REMINDER_TIME", "REMINDER_WEEKDAY", "REMINDER_ZONE", "WEBAPP_URL"].forEach((key) => {
    assert.match(installer, new RegExp("^" + key + "=", "m"), key + " missing from the env template");
  });
  // The template must match the documented default slot, and must not pin a
  // fixed offset: that would opt the server out of the seasonal changes.
  assert.match(installer, /^REMINDER_TIME=19:00$/m);
  assert.match(installer, /^REMINDER_WEEKDAY=1$/m);
  assert.match(installer, /^REMINDER_ZONE=Europe\/Kyiv$/m);
  assert.doesNotMatch(installer, /^REMINDER_UTC_OFFSET=.+$/m);
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
    // Without pre_checkout_query no payment could ever be confirmed in time.
    assert.deepEqual(body.allowed_updates, ["message", "callback_query", "pre_checkout_query"]);
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
    if (method === "createInvoiceLink") return "https://t.me/$fakeinvoice";
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
  assert.deepEqual(h.client.calls.map((call) => call.method), ["sendMessage", "sendMessage"]);
  assert.equal(h.client.calls[0].payload.chat_id, 8);
});

test("runtime: the Monday sweep reminds once per weekly slot", async () => {
  const h = runtimeHarness();
  h.store.updateUser(8, { remindersEnabled: true });
  grantAccess(h.store, 8, JUST_AFTER_SLOT);
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
  grantAccess(h.store, 9, WED_NOON_UTC);
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
  grantAccess(h.store, 8, JUST_AFTER_SLOT);
  h.client.failWith = new TelegramError("blocked", { status: 403, fatal: true });
  assert.deepEqual(await h.runtime.sweepReminders(JUST_AFTER_SLOT), []);
  assert.equal(h.store.user(8).remindersEnabled, false);
  assert.equal(h.store.user(8).lastRemindedAt, MONDAY_SLOT_UTC);
});

test("runtime: a transient reminder failure leaves the slot pending", async () => {
  const h = runtimeHarness();
  h.store.updateUser(8, { remindersEnabled: true });
  grantAccess(h.store, 8, JUST_AFTER_SLOT);
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

// --------------------------------------------------------------- review regressions

test("reminder: the first Monday after the October switch reminds once, at 19:00 local", () => {
  const defaults = { time: "19:00", weekday: MONDAY, zone: "Europe/Kyiv", offsetMinutes: null };
  const user = { chatId: 1, remindersEnabled: true, lastRemindedAt: Date.parse("2026-10-19T16:00:00Z") };
  const sent = [];
  for (let now = Date.parse("2026-10-26T12:00:00Z"); now < Date.parse("2026-10-26T20:00:00Z"); now += 60000) {
    const due = dueReminders({ users: [user], nowMs: now, defaults, graceMs: 12 * 60 * 60 * 1000 });
    if (!due.length) continue;
    sent.push(now);
    user.lastRemindedAt = due[0].dueAt;
  }
  assert.deepEqual(sent, [Date.parse("2026-10-26T17:00:00Z")], "once, at 19:00 Kyiv, which is 17:00 UTC in winter");
  // In the hour before the slot the last one is still the previous Monday.
  const schedule = { weekday: MONDAY, hour: 19, minute: 0, zone: "Europe/Kyiv" };
  assert.equal(lastDueBefore(Date.parse("2026-10-26T16:30:00Z"), schedule), Date.parse("2026-10-19T16:00:00Z"));
  assert.equal(nextDueAfter(Date.parse("2026-10-26T16:30:00Z"), schedule), Date.parse("2026-10-26T17:00:00Z"));
});

test("telegram: a connection dropped mid-body rejects instead of hanging", async () => {
  const { server, port } = await startServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
    response.write('{"ok":true,"result":[');
    setTimeout(() => response.socket.destroy(), 20);
  });
  const client = new TelegramClient({ token: FAKE_TOKEN, apiBase: "http://127.0.0.1:" + port });
  let timer = null;
  const outcome = await Promise.race([
    client.call("getUpdates", {}, { maxAttempts: 1, timeoutMs: 5000 }).then(() => "resolved", (error) => error),
    new Promise((done) => { timer = setTimeout(() => done("still pending"), 3000); }),
  ]);
  clearTimeout(timer);
  await closeServer(server);
  assert.ok(outcome instanceof TelegramError, "the call must settle, got " + String(outcome));
  assert.equal(outcome.fatal, false, "a dropped connection is worth a retry");
});

test("paywall: an older invoice cannot charge someone who already bought", () => {
  const h = harness();
  h.say("/start");
  grantAccess(h.store, 777, h.clock.now);
  const answer = h.router.handleUpdate({
    update_id: 30,
    pre_checkout_query: { id: "pcq9", from: { id: 777 }, currency: "XTR", total_amount: 100, invoice_payload: "pro-v1:777" },
  });
  assert.equal(answer[0].payload.ok, false);
  assert.match(answer[0].payload.error_message, /уже відкритий/);
  assert.equal(h.store.user(777).pro.chargeId, "ch_test", "the charge on record stays the first one");
  assert.equal(checkPreCheckout({ currency: "XTR", invoice_payload: "pro-v1:777" }, 777, h.store.user(777)).ok, false);
});

test("runtime: a 403 from one chat keeps the actions for every other chat", async () => {
  const h = runtimeHarness();
  h.store.updateUser(2, { remindersEnabled: true });
  const calls = [];
  h.runtime.client = {
    redact: (text) => String(text),
    call: async (method, payload) => {
      calls.push(payload.chat_id);
      if (payload.chat_id === 2 || payload.chat_id === 4) throw new TelegramError("blocked", { status: 403, fatal: true });
      return {};
    },
  };
  await h.runtime.runActions([
    { method: "sendMessage", payload: { chat_id: 1, text: "result" } },
    { method: "sendMessage", payload: { chat_id: 2, text: "alert to a specialist who blocked the bot" } },
    { method: "sendMessage", payload: { chat_id: 2, text: "more for the same blocked chat" } },
    { method: "sendMessage", payload: { chat_id: 3, text: "alert to another specialist" } },
    { method: "sendMessage", payload: { chat_id: 4, text: "a chat with no record" } },
  ]);
  assert.deepEqual(calls, [1, 2, 3, 4], "only the blocked chat's second message is skipped");
  assert.equal(h.store.user(2).remindersEnabled, false);
  assert.equal(h.store.hasUser(4), false, "a 403 never recreates a record");
});

test("runtime: a pre-checkout query is answered before slow sends earlier in the batch", async () => {
  const h = runtimeHarness();
  let release = null;
  const gate = new Promise((done) => { release = done; });
  const order = [];
  h.runtime.client = {
    redact: (text) => String(text),
    getUpdates: async () => [
      { update_id: 700, message: { message_id: 1, chat: { id: 8, type: "private" }, text: "/start" } },
      { update_id: 701, pre_checkout_query: { id: "pcq_fast", from: { id: 9 }, currency: "XTR", total_amount: 100, invoice_payload: "pro-v1:9" } },
    ],
    call: async (method) => {
      order.push(method);
      if (method === "sendMessage" && order.length === 2) await gate;
      return {};
    },
  };
  const polled = h.runtime.pollOnce();
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(order[0], "answerPreCheckoutQuery", "the payment is not left waiting on the message sends");
  release();
  assert.equal(await polled, 2);
  assert.equal(order.filter((method) => method === "answerPreCheckoutQuery").length, 1, "answered once");
  assert.equal(h.store.offset, 702);
});

test("runtime: a sweep that outlasts the tick does not overlap the next one", async () => {
  const h = runtimeHarness();
  [8, 9].forEach((chatId) => {
    h.store.updateUser(chatId, { remindersEnabled: true });
    grantAccess(h.store, chatId, JUST_AFTER_SLOT);
  });
  let release = null;
  const gate = new Promise((done) => { release = done; });
  const sent = [];
  h.runtime.client = {
    redact: (text) => String(text),
    call: async (method, payload) => {
      sent.push(payload.chat_id);
      if (sent.length === 1) await gate;
      return {};
    },
  };
  const first = h.runtime.sweepReminders(JUST_AFTER_SLOT);
  assert.deepEqual(await h.runtime.sweepReminders(JUST_AFTER_SLOT + 60000), [], "the next tick leaves the sweep in flight alone");
  release();
  assert.deepEqual(await first, [8, 9]);
  assert.deepEqual(sent, [8, 9], "each chat is reminded once");
  assert.equal(h.runtime.sweeping, false);
});

test("note: a start button drops the waiting note, so a typed digit answers the new questionnaire", () => {
  const h = harness();
  completeViaKeyboard(h, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(h.sessions.pendingNoteCount(), 1);
  h.tap("s|phq9");
  assert.equal(h.sessions.pendingNoteCount(), 0);
  h.say("2");
  assert.equal(h.store.lastResult(777, "gad7").note, undefined, "the digit is not a note");
  assert.equal(h.sessions.get(777, h.clock.now).index, 1, "it answered the first PHQ-9 question");
});

test("psy: an unfinished application neither outlives /cancel nor swallows a questionnaire", () => {
  const h = harness();
  h.say("/start");
  h.tap("py|apply");
  assert.match(lastText(h.say("/cancel")), /Заявку скасовано/);
  assert.equal(h.sessions.application(777, h.clock.now), null);
  h.tap("py|apply");
  h.say("/gad7");
  h.say("2");
  assert.equal(h.sessions.get(777, h.clock.now).index, 1, "the digit answered GAD-7");
  assert.equal(h.sessions.application(777, h.clock.now), null);
});

test("booking: a request cut through an emoji still becomes a working link", () => {
  const h = harness({ config: { contact: { username: "helper_psy", name: "Олексій", role: "психолог" } } });
  h.say("/start");
  h.say("/book");
  h.tap("b|f|online");
  h.tap("b|t|day");
  const ready = h.say("а".repeat(299) + "😊 і далі");
  const url = ready[ready.length - 1].payload.reply_markup.inline_keyboard[0][0].url;
  assert.ok(decodeURIComponent(url).endsWith("Запит: " + "а".repeat(299)), "the half emoji is dropped, not encoded");
  assert.equal(clipText("а".repeat(299) + "😊", 300), "а".repeat(299));
  assert.equal(clipText("😊😊", 3), "😊");
  assert.equal(clipText("коротко", 300), "коротко");
});

test("history: a long /results and /last are split into messages Telegram accepts", () => {
  const h = harness();
  h.say("/start");
  grantAccess(h.store, 777, h.clock.now);
  const note = "Тиждень був непростий: багато роботи, мало сну, але вихідні з друзями допомогли відновитися.";
  [GAD7, PHQ9, SLEEP, STRESS, PCL5, WELLBEING].forEach((instrument) => {
    for (let week = 9; week >= 0; week--) {
      const answers = instrument.items.map(() => 1);
      const stored = h.store.addResult(777, buildResult(instrument, answers, WED_NOON_UTC - week * WEEK_MS));
      h.store.annotateResult(777, stored, week === 0 ? "я".repeat(MAX_NOTE_LENGTH) : note);
    }
  });
  ["/results", "/last"].forEach((command) => {
    const messages = h.say(command);
    assert.ok(messages.length > 1, command + " would be refused as one message");
    messages.forEach((action) => assert.ok(action.payload.text.length <= MESSAGE_LIMIT, command));
    assert.equal(messages.filter((action) => action.payload.reply_markup).length, 1, command + " keyboard");
    assert.ok(messages[messages.length - 1].payload.reply_markup, command + " keyboard goes last");
  });
  const last = textsOf(h.say("/last")).join("\n");
  assert.equal(last.split("я".repeat(MAX_NOTE_LENGTH)).length - 1, 6, "/last still shows every note in full");
});

test("psy: thirty clients with every scale still fit in messages Telegram accepts", () => {
  const row = "⚠️ Олександра Коваленко, з 01.09.2026: GAD-7 12/21 (+3), PHQ-9 15/27 (-2), Сон 14/28 (+1), " +
    "Стрес 20/32 (+4), PCL-5 40/80 (+10), Самопочуття 8/24 (-1), настрій 5,4";
  const messages = psyClientsList(Array.from({ length: 35 }, () => row));
  assert.ok(messages.length > 1);
  messages.forEach((text) => assert.ok(text.length <= MESSAGE_LIMIT));
  assert.match(messages[messages.length - 1], /Ще клієнтів: 5\./);
});

test("webapp: reminder settings from the app are locked after the trial, like /remind", () => {
  const h = harness({ config: { webappUrl: "https://example.pages.dev/" } });
  h.say("/start");
  h.clock.now += 20 * DAY;
  const actions = h.router.handleUpdate({
    update_id: 13,
    message: {
      message_id: 1,
      chat: h.chat,
      web_app_data: { data: JSON.stringify({ v: 1, type: "reminders", time: "08:15", tz: 120 }) },
    },
  });
  assert.match(lastText(actions), /Повний доступ/);
  assert.equal(h.store.user(777).reminderTime, null);
  assert.equal(h.store.user(777).tzOffsetMinutes, null);
});

test("config: the trial lasts 7 days unless TRIAL_DAYS says otherwise", () => {
  const env = (extra) => Object.assign({ BOT_TOKEN: FAKE_TOKEN, MEMORY_ONLY: "1" }, extra);
  assert.equal(loadConfig(env({}), { envFile: false }).price.trialDays, 7);
  assert.equal(loadConfig(env({ TRIAL_DAYS: "14" }), { envFile: false }).price.trialDays, 14);
  const installer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "install.sh"), "utf8");
  assert.match(installer, /^TRIAL_DAYS=7$/m, "a fresh server starts with the same default");
});

test("config: full access costs 150 Stars and the cabinet 300 a month unless set otherwise", () => {
  const env = (extra) => Object.assign({ BOT_TOKEN: FAKE_TOKEN, MEMORY_ONLY: "1" }, extra);
  const config = loadConfig(env({}), { envFile: false });
  assert.equal(config.price.stars, 150);
  assert.equal(config.psy.stars, 300);
  assert.match(config.price.description, /Одноразово, без підписки/);
  assert.ok(config.price.description.length <= 255, "Telegram's cap for an invoice description");
  const custom = loadConfig(env({ PRICE_STARS: "120", PSY_PRICE_STARS: "250" }), { envFile: false });
  assert.deepEqual([custom.price.stars, custom.psy.stars], [120, 250]);
  const installer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "install.sh"), "utf8");
  assert.match(installer, /^PRICE_STARS=150$/m);
  assert.match(installer, /^PSY_PRICE_STARS=300$/m);
});

test("config: an empty REMINDER_WEEKDAY keeps the Monday default", () => {
  const env = (weekday) => ({ BOT_TOKEN: FAKE_TOKEN, MEMORY_ONLY: "1", REMINDER_WEEKDAY: weekday });
  assert.equal(loadConfig(env(""), { envFile: false }).reminder.weekday, MONDAY);
  assert.equal(loadConfig(env("  "), { envFile: false }).reminder.weekday, MONDAY);
  assert.equal(loadConfig(env("0"), { envFile: false }).reminder.weekday, 0, "Sunday stays reachable");
});

test("psy: an alert on one of the bot's own scales says it is not a validated tool", () => {
  const h = linkedHarness();
  const high = completeViaKeyboard(h, STRESS, [4, 4, 4, 0, 4, 0, 4, 4]);
  const alert = high.find((action) => action.payload && action.payload.chat_id === PSY);
  assert.match(alert.payload.text, /Стрес: 32 з 32/);
  assert.match(alert.payload.text, /власна шкала самоспостереження/);
});

test("deploy: the off-machine backup reads its key where the sandboxed unit can reach it", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy");
  const backup = readFileSync(join(dir, "backup.sh"), "utf8");
  const unit = readFileSync(join(dir, "gad7-phq9-backup.service"), "utf8");
  const guide = readFileSync(join(dir, "DEPLOY.md"), "utf8");
  assert.match(unit, /ProtectHome=yes/, "the unit hides /home, so ~/.ssh is out of reach");
  assert.match(backup, /SSH_DIR:-\/var\/lib\/gad7-phq9-bot\/\.ssh/);
  assert.match(backup, /-i "\$SSH_DIR\/id_ed25519"/);
  assert.match(guide, /\/var\/lib\/gad7-phq9-bot\/\.ssh\/id_ed25519/);
});

// --------------------------------------------------------------- access button

test("access: the button under the input shows what the purchase opens, the price and a pay button", () => {
  const h = harness();
  h.say("/start");
  assert.ok(isAccessText(ACCESS_BUTTON));
  assert.ok(isAccessText("  Повний доступ "));
  const offer = h.say(ACCESS_BUTTON);
  assert.equal(offer.length, 1);
  const text = offer[0].payload.text;
  assert.match(text, /залишилося днів 7/);
  [PCL5, WELLBEING, SLEEP, STRESS].forEach((instrument) => assert.match(text, new RegExp(instrument.title)));
  assert.match(text, /щоденна відмітка настрою/);
  assert.match(text, /Що назавжди безкоштовно/);
  assert.match(text, /<b>100 зірок одноразово, без підписки<\/b>/);
  assert.match(text, /\/paysupport/);
  assert.match(text, /кабінет із клієнтами і сповіщеннями: \/psy/, "specialists find their subscription from here");
  const button = offer[0].payload.reply_markup.inline_keyboard[0][0];
  assert.equal(button.callback_data, "pay|start");
  assert.equal(button.text, "Відкрити повний доступ за 100 зірок");
  assert.equal(h.tap("pay|start")[1].method, "sendInvoice");
  assert.deepEqual(textsOf(h.say("/buy")), textsOf(offer), "/buy is the same screen");

  h.clock.now += 20 * DAY;
  const lapsed = h.say(ACCESS_BUTTON);
  assert.match(lapsed[0].payload.text, /Безкоштовний період закінчився/);
  assert.equal(lapsed[0].payload.reply_markup.inline_keyboard[0][0].callback_data, "pay|start");
});

test("access: once bought, the screen says so, and the keyboard drops the button", () => {
  const withApp = harness({ config: { webappUrl: "https://example.pages.dev/" } });
  withApp.say("/start");
  grantAccess(withApp.store, 777, withApp.clock.now);
  const bought = withApp.say(ACCESS_BUTTON);
  assert.match(bought[0].payload.text, /Відкрито назавжди/);
  assert.match(bought[0].payload.text, /Що входить/);
  assert.doesNotMatch(bought[0].payload.text, /Ціна|безкоштовно/);
  assert.equal(bought[0].payload.reply_markup, undefined, "nothing left to pay");
  const rows = withApp.say("/start")[0].payload.reply_markup.keyboard;
  assert.deepEqual(rows.map((row) => row[0].text), ["Відкрити застосунок", "🆘 Мені зараз погано"]);
  assert.match(rows[0][0].web_app.url, /[?&]plan=pro&price=100$/);

  const chatOnly = harness();
  chatOnly.say("/start");
  grantAccess(chatOnly.store, 777, chatOnly.clock.now);
  assert.deepEqual(chatOnly.say("/start")[1].payload.reply_markup.keyboard, [[{ text: "🆘 Мені зараз погано" }]]);
});

test("access: the button is never taken as an answer, a note, a booking request or an application", () => {
  const h = harness({ config: { contact: { username: "helper_psy", name: "Олексій", role: "психолог" } } });
  h.say("/start");
  h.say("/gad7");
  assert.match(h.say(ACCESS_BUTTON)[0].payload.text, /Що відкривається/);
  assert.equal(h.sessions.get(777, h.clock.now).index, 0, "the questionnaire waits where it was");
  h.say("2");
  assert.equal(h.sessions.get(777, h.clock.now).index, 1);

  const noted = harness();
  completeViaKeyboard(noted, GAD7, [1, 1, 1, 1, 1, 1, 1]);
  noted.say(ACCESS_BUTTON);
  assert.equal(noted.store.lastResult(777, "gad7").note, undefined, "not saved as the weekly note");

  h.say("/cancel");
  h.say("/book");
  h.tap("b|f|online");
  h.tap("b|t|day");
  h.say(ACCESS_BUTTON);
  const booking = h.sessions.booking(777, h.clock.now);
  assert.equal(booking.step, "request");
  assert.equal(booking.request, null, "not taken as the request text");

  h.tap("py|apply");
  h.say(ACCESS_BUTTON);
  assert.equal(h.sessions.application(777, h.clock.now).step, "name", "not taken as the applicant's name");
});

test("access: the chat, the paywall and the app promise the same things", () => {
  const unlocked = unlockedLines();
  INSTRUMENT_LIST.filter((instrument) => instrument.paid).forEach((instrument) => {
    assert.ok(unlocked.some((line) => line.indexOf(instrument.title + ":") === 0), instrument.id);
  });
  INSTRUMENT_LIST.filter((instrument) => !instrument.paid).forEach((instrument) => {
    assert.ok(freeLines().some((line) => line.indexOf(instrument.title + ":") === 0), instrument.id);
  });
  const price = fixtureConfig().price;
  const offer = accessOffer(price, { kind: "trial", daysLeft: 3, active: true });
  const locked = paywall(price, { kind: "expired", daysLeft: 0, active: false });
  unlocked.concat(freeLines()).forEach((line) => {
    assert.ok(offer.indexOf(escapeHtml(line)) !== -1, "offer: " + line);
    assert.ok(locked.indexOf(escapeHtml(line)) !== -1, "paywall: " + line);
  });
});

test("webapp: the app's pay button asks the bot for the invoice", () => {
  assert.deepEqual(parseWebAppPayload(JSON.stringify({ v: 1, type: "buy" })), { ok: true, payload: { type: "buy" } });
  const h = harness({ config: { webappUrl: "https://example.pages.dev/" } });
  h.say("/start");
  const buy = (id) => h.router.handleUpdate({
    update_id: id,
    message: { message_id: 1, chat: h.chat, web_app_data: { data: JSON.stringify({ v: 1, type: "buy" }) } },
  });
  const invoice = buy(40);
  assert.equal(invoice[0].method, "sendInvoice");
  assert.equal(invoice[0].payload.payload, "pro-v1:777", "the invoice is built for the sender, never from the payload");
  grantAccess(h.store, 777, h.clock.now);
  assert.match(lastText(buy(41)), /уже відкритий/);
});

test("webapp: the access screen reads the shared offer and pays through the bot", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "..", "webapp", "index.html"), "utf8");
  const app = readFileSync(join(here, "..", "webapp", "app.js"), "utf8");
  assert.match(html, /<div id="access" class="screen">/);
  const menu = html.slice(html.indexOf('id="home-menu"'));
  assert.ok(menu.indexOf('id="mood-card"') < menu.indexOf('id="access-card"'), "the offer sits under the locked items");
  assert.ok(html.indexOf('id="access-pay"') < html.indexOf('id="access-free-card"'), "the pay button comes before the fine print");
  assert.match(app, /from "\.\/offer\.mjs"/);
  assert.match(app, /submit\(\{ type: "buy" \}\)/);
  assert.doesNotMatch(app, /щоденна відмітка настрою|Відкрито назавжди|одноразово, без підписки/, "the app restates no shared text");
  assert.doesNotMatch(app, /командою \/buy/, "a lock opens the offer instead of pointing at a command");
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
