#!/usr/bin/env node
// Load simulation through the real router. Zero dependencies. Node 16+.
//
//   npm run swarm
//   node telegram-bot/tests/swarm.mjs [--users 1000] [--days 21] [--seed 20261015]
//
// 1000 synthetic people in eight personas live 21 days with the bot: they
// start, take tests, write notes and free text, mark their mood, answer or
// ignore reminders, pay, delete their data, apply as specialists and give
// homework. Every reply goes through the same checks, and the run exits with
// code 1 on any violation:
//
//   - the router throws;
//   - a message is longer than 4096 characters;
//   - callback_data is longer than 64 bytes;
//   - the last row of a reply keyboard is not "Мені зараз погано";
//   - a personal contact stands above 103 in the same message;
//   - someone at risk (PHQ-9 item 9 or a typed crisis phrase) is shown a
//     payment they did not ask for;
//   - a free feature asks for payment after the trial;
//   - a second payment passes the pre-checkout;
//   - data is left after /delete;
//   - a crisis phrase gets a reply without 7333.
//
// The run is deterministic: one seeded generator decides everything, and the
// router's clock is the simulation's clock. At the end it prints the funnel
// per persona.

import { Store } from "../src/store.mjs";
import { SessionManager } from "../src/session.mjs";
import { createRouter } from "../src/router.mjs";
import { DEFAULT_CRISIS_CONTACT } from "../src/config.mjs";
import { INSTRUMENTS } from "../src/instruments.mjs";
import { SOS_BUTTON } from "../src/selfhelp.mjs";
import { ACCESS_BUTTON, weeklyReminder } from "../src/texts.mjs";
import { dueReminders } from "../src/reminders.mjs";
import { entitlement } from "../src/billing.mjs";
import { detectCrisis } from "../src/crisis.mjs";

// ---------------------------------------------------------------- options

function option(name, fallback) {
  const at = process.argv.indexOf("--" + name);
  return at !== -1 && process.argv[at + 1] ? Number(process.argv[at + 1]) : fallback;
}
const USERS = option("users", 1000);
const DAYS = option("days", 21);
const SEED = option("seed", 20261015);

// mulberry32: small, fast, and the same sequence on every machine.
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = generator(SEED);
const chance = (p) => random() < p;
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (low, high) => low + Math.floor(random() * (high - low + 1));

// ---------------------------------------------------------------- the bot

const OWNER = 1;
const CONTACT = { username: "justajsi", name: "Олексій", role: "психолог" };
const config = {
  crisisContact: DEFAULT_CRISIS_CONTACT,
  reminder: { time: "19:00", weekday: 1, zone: "Europe/Kyiv", offsetMinutes: null, graceMs: 12 * 60 * 60 * 1000 },
  pollTimeoutSeconds: 1,
  tickSeconds: 60,
  sessionIdleTimeoutMs: 60 * 60 * 1000,
  memoryOnly: true,
  dataFile: null,
  webappUrl: "https://moddtracker.pages.dev/",
  contact: CONTACT,
  admin: { username: "owner_acc", chatId: null },
  psy: { stars: 300, title: "Кабінет фахівця", description: "Клієнти і сповіщення. Щомісячна підписка." },
  botUsername: "ModdTrackerBot",
  price: { stars: 150, trialDays: 7, title: "Повний доступ", description: "Додаткові шкали, історія, статистика." },
};

const START_MS = Date.parse("2026-10-05T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
// Kyiv 09:30, 14:00 and 21:10 before the October change, 20:10 after it.
const SLOTS_UTC_MINUTES = [6 * 60 + 30, 11 * 60, 18 * 60 + 10];

const clock = { now: START_MS };
const store = new Store({ file: null });
const sessions = new SessionManager({ idleTimeoutMs: config.sessionIdleTimeoutMs });
const router = createRouter({ store, sessions, config, now: () => clock.now });

// ---------------------------------------------------------------- checks

const violations = [];
const violationKinds = {};
function violate(kind, detail) {
  violationKinds[kind] = (violationKinds[kind] || 0) + 1;
  if (violations.length < 40) violations.push(kind + ": " + detail);
}

const textOf = (action) => (action.payload && typeof action.payload.text === "string" ? action.payload.text : "");
const keyboardOf = (action) => (action.payload && action.payload.reply_markup) || null;

function showsPayment(actions) {
  return actions.some((action) => {
    if (action.method === "sendInvoice") return true;
    const markup = JSON.stringify(keyboardOf(action) || {});
    return markup.indexOf("pay|start") !== -1 || markup.indexOf("acc|show") !== -1;
  });
}

// `context`: { explicitPay, freeFeature, crisis }
function check(actions, user, context = {}) {
  actions.forEach((action) => {
    const text = textOf(action);
    if (text.length > 4096) violate("message over 4096", user.persona + " " + text.length);
    const markup = keyboardOf(action);
    if (markup && Array.isArray(markup.inline_keyboard)) {
      markup.inline_keyboard.flat().forEach((button) => {
        if (button.callback_data && Buffer.byteLength(button.callback_data, "utf8") > 64) {
          violate("callback_data over 64 bytes", button.callback_data);
        }
      });
    }
    if (markup && Array.isArray(markup.keyboard)) {
      const last = markup.keyboard[markup.keyboard.length - 1];
      if (!last || last.length !== 1 || last[0].text !== SOS_BUTTON) violate("SOS not last", JSON.stringify(last));
    }
    if (text.indexOf("103") !== -1) {
      const contactAt = Math.min(...["@" + CONTACT.username, "t.me/" + CONTACT.username, CONTACT.name]
        .map((needle) => text.indexOf(needle)).filter((at) => at !== -1).concat([Infinity]));
      if (contactAt < text.indexOf("103")) violate("contact above 103", user.persona);
    }
  });
  const chatId = user.chatId;
  if (store.hasUser(chatId) && router.atRisk(chatId) && !context.explicitPay && showsPayment(actions)) {
    violate("payment shown to someone at risk", user.persona);
  }
  if (context.freeFeature && store.hasUser(chatId)) {
    const state = entitlement(store.user(chatId), clock.now);
    if (!state.active && showsPayment(actions)) violate("free feature asks for payment", user.persona + " " + context.freeFeature);
  }
  if (context.crisis && !actions.some((action) => textOf(action).indexOf("7333") !== -1)) {
    violate("crisis without 7333", user.persona);
  }
  // The funnel, per persona.
  if (showsPayment(actions)) user.sawPayment = true;
  if (actions.some((action) => action.method === "sendInvoice")) user.gotInvoice = true;
}

function run(user, update, context) {
  if (user.deleted && !context.restart) return [];
  user.lastActiveDay = user.today;
  let actions = [];
  try {
    actions = router.handleUpdate(update);
  } catch (error) {
    violate("router threw", user.persona + " " + String(error && error.stack).split("\n").slice(0, 2).join(" "));
    return [];
  }
  check(actions, user, context);
  return actions;
}

let updateId = 1;
function say(user, text, context = {}) {
  const crisis = detectCrisis(text) && !text.startsWith("/");
  // Asking for the offer is the person's own choice, whoever they are.
  const explicitPay = text === ACCESS_BUTTON || text.split(" ")[0] === "/buy";
  return run(user, {
    update_id: updateId++,
    message: { message_id: updateId, chat: { id: user.chatId, type: "private" },
      from: { id: user.chatId, first_name: user.name, username: user.username }, text },
  }, Object.assign({ crisis, explicitPay }, context));
}

function tap(user, data, context = {}) {
  const explicitPay = data.indexOf("pay|") === 0 || data.indexOf("acc|") === 0;
  return run(user, {
    update_id: updateId++,
    callback_query: { id: "cb" + updateId, data, from: { id: user.chatId, first_name: user.name, username: user.username },
      message: { message_id: updateId, chat: { id: user.chatId, type: "private" } } },
  }, Object.assign({ explicitPay }, context));
}

function payViaMessage(user, payment) {
  return run(user, {
    update_id: updateId++,
    message: { message_id: updateId, chat: { id: user.chatId, type: "private" }, from: { id: user.chatId },
      successful_payment: payment },
  }, {});
}

function preCheckout(user, payload, amount) {
  return run(user, {
    update_id: updateId++,
    pre_checkout_query: { id: "pq" + updateId, from: { id: user.chatId }, currency: "XTR", total_amount: amount,
      invoice_payload: payload },
  }, { explicitPay: true });
}

// ---------------------------------------------------------------- shared moves

function start(user) {
  if (!user.started) user.started = true;
  user.startDay = user.startDay === null ? user.today : user.startDay;
  return say(user, "/start", { restart: true });
}

// Answers a questionnaire through its inline buttons. `value(index)` picks an
// answer; the options of the current item bound it.
function takeTest(user, id, value) {
  const instrument = INSTRUMENTS[id];
  const free = !instrument.paid;
  const begun = say(user, instrument.command, { freeFeature: free ? instrument.command : null });
  if (!sessions.get(user.chatId, clock.now)) return begun;
  let last = [];
  for (let index = 0; index < instrument.items.length; index++) {
    const session = sessions.get(user.chatId, clock.now);
    if (!session) break;
    const options = instrument.items[index].options;
    const wanted = Math.max(0, Math.min(options.length - 1, value(index, instrument)));
    last = tap(user, ["a", session.id, index, options[wanted].value].join("|"), { freeFeature: free ? "answer" : null });
  }
  if (store.hasUser(user.chatId) && store.user(user.chatId).results.length) user.tested = true;
  return last;
}

function skipOrWriteNote(user, text) {
  const pending = sessions.pendingNote(user.chatId, clock.now);
  if (!pending) return;
  if (text) say(user, text, { freeFeature: "note" });
  else tap(user, "n|" + pending.id, { freeFeature: "note" });
}

function buy(user) {
  const offered = tap(user, "pay|start", { explicitPay: true });
  const invoice = offered.find((action) => action.method === "sendInvoice");
  if (!invoice) return;
  const payload = invoice.payload.payload;
  const answer = preCheckout(user, payload, config.price.stars).find((action) => action.method === "answerPreCheckoutQuery");
  if (!answer || !answer.payload.ok) return;
  payViaMessage(user, {
    currency: "XTR", total_amount: config.price.stars, invoice_payload: payload,
    telegram_payment_charge_id: "ch_" + user.chatId + "_" + updateId,
  });
  user.paid = true;
  // The same invoice again must be refused at the pre-checkout.
  const second = preCheckout(user, payload, config.price.stars).find((action) => action.method === "answerPreCheckoutQuery");
  if (second && second.payload.ok) violate("second payment passed pre-checkout", user.persona);
}

function deleteAll(user) {
  say(user, "/delete", { freeFeature: "/delete" });
  tap(user, "del|yes", { freeFeature: "del" });
  if (store.hasUser(user.chatId)) violate("data left after /delete", user.persona);
  if (sessions.get(user.chatId, clock.now) || sessions.pendingNote(user.chatId, clock.now)) {
    violate("session left after /delete", user.persona);
  }
  user.deleted = true;
}

const FREE_COMMANDS = ["/sos", "/selfhelp", "/report", "/export", "/contact", "/book"];
const CRISIS_TEXTS = ["мені погано", "я не хочу жити", "хочу померти", "мне плохо", "не хочу жить", "допоможіть",
  "немає сенсу жити", "мені дуже погано, не можу більше"];
const CONFUSED_TEXTS = ["привіт", "що це?", "як користуватися", "скільки коштує", "тест", "мені погано спиться",
  "психолог потрібен", "здравствуйте", "сколько стоит", "хочу пройти тест", "ок", "дякую", "а де результати",
  "?", "помогите разобраться", "консультація", "1", "погода погана"];
const CHAOS_TEXTS = ["asdf", "/unknown", "", "      ", "🙂", "<b>x</b>", "/start c_nonexistent", "/tz +25", "/remind 99:99",
  "/remind 07:30", "/tz auto", "a".repeat(5000), "/gad7", "5", "0", "/cancel", "мені погано", ACCESS_BUTTON,
  "⬅️ Головне меню", "📝 Тести", SOS_BUTTON, "/buy", "/results", "/psy", "/invite", "/clients", "/admin", "/stats"];
const CHAOS_TAPS = ["a|zz|0|1", "zz|1", "del|no", "s|nope", "p|gad7", "pp|menu", "m|11", "m|3", "mt|2020-01-01|sleep",
  "hd|deadbeef", "hw|1", "cl|1", "acc|show", "mn|tests", "dm|on", "dm|off", "rep|plain", "b|start", "r|on"];
const NOTES = ["Тиждень був важкий через роботу.", "Більше спав, стало легше.", "", "Сварка з близькими."];

// ---------------------------------------------------------------- personas

const PERSONAS = {
  curious: {
    label: "любопитний",
    day(user) {
      if (!user.started) {
        start(user);
        // The greeting's two-minute button or nothing.
        if (chance(0.45)) {
          tap(user, "s|gad7", { freeFeature: "s|gad7" });
          const session = sessions.get(user.chatId, clock.now);
          if (session) {
            sessions.cancel(user.chatId);
            takeTest(user, "gad7", () => between(0, 2));
            skipOrWriteNote(user, chance(0.3) ? pick(NOTES) : "");
          }
        }
        return;
      }
      if (chance(0.15)) say(user, pick(["📝 Тести", "📈 Результати", "🌿 Підтримка", "/help"]));
      if (chance(0.08)) takeTest(user, pick(["gad7", "phq9"]), () => between(0, 2));
      if (chance(0.03)) buy(user);
    },
  },
  anxious: {
    label: "тривожний",
    day(user) {
      if (!user.started) start(user);
      if (chance(0.35)) {
        takeTest(user, "gad7", () => between(1, 3));
        skipOrWriteNote(user, chance(0.5) ? "Тривожно через новини і роботу." : "");
      }
      if (chance(0.3)) tap(user, "m|" + between(3, 7));
      if (chance(0.2)) tap(user, "p|gad7", { freeFeature: "p|gad7" });
      if (chance(0.1)) say(user, "мені тривожно");
      if (user.today - user.startDay >= 5 && chance(0.08)) buy(user);
    },
  },
  depressed: {
    label: "пригнічений",
    day(user) {
      if (!user.started) start(user);
      const item9 = user.risky ? between(1, 3) : 0;
      if (chance(0.3)) {
        takeTest(user, "phq9", (index) => (index === 8 ? item9 : between(1, 3)));
        skipOrWriteNote(user, user.risky && chance(0.3) ? pick(CRISIS_TEXTS) : (chance(0.4) ? pick(NOTES) : ""));
      }
      if (user.risky && chance(0.15)) say(user, pick(CRISIS_TEXTS));
      if (chance(0.2)) say(user, pick(["/results", "/sleep", "/mood", "📈 Результати", "скільки коштує", "/remind"]));
      if (chance(0.15)) say(user, pick(["/sos", SOS_BUTTON]), { freeFeature: "/sos" });
      if (chance(0.2)) tap(user, "m|" + between(1, 4));
    },
  },
  tracker: {
    label: "трекер",
    day(user) {
      if (!user.started) {
        start(user);
        takeTest(user, "gad7", () => between(0, 2));
        skipOrWriteNote(user, pick(NOTES));
      }
      if (chance(0.9)) tap(user, "m|" + between(4, 9));
      if ((user.today - user.startDay) % 7 === 3) takeTest(user, pick(["gad7", "phq9", "sleep", "stress"]), () => between(0, 2));
      if (user.sawTrialNotice && !user.paid && chance(0.6)) buy(user);
      if (user.today - user.startDay >= 6 && !user.paid && chance(0.15)) buy(user);
    },
  },
  frugal: {
    label: "економний",
    day(user) {
      if (!user.started) start(user);
      if (chance(0.3)) {
        takeTest(user, pick(["gad7", "phq9"]), () => between(0, 2));
        skipOrWriteNote(user, "");
      }
      if (chance(0.3)) say(user, pick(FREE_COMMANDS), { freeFeature: "free command" });
      if (chance(0.1)) say(user, pick(["/results", "/last", "/sleep"]));
      if (chance(0.05)) tap(user, "rep|plain", { freeFeature: "report" });
    },
  },
  chaotic: {
    label: "хаотичний",
    day(user) {
      if (!user.started || user.deleted) {
        user.deleted = false;
        start(user);
      }
      for (let step = 0; step < between(1, 5); step++) {
        if (chance(0.5)) say(user, pick(CHAOS_TEXTS));
        else tap(user, pick(CHAOS_TAPS));
      }
      if (chance(0.15)) takeTest(user, pick(Object.keys(INSTRUMENTS)), () => between(0, 4));
      if (chance(0.04)) buy(user);
      if (chance(0.05)) deleteAll(user);
    },
  },
  psychologist: {
    label: "психолог",
    day(user) {
      if (!user.started) {
        start(user);
        say(user, "/psy");
        tap(user, "py|apply");
        say(user, "Фахівчиня " + user.chatId);
        say(user, "Психолог, 5 років практики");
        tap(user, "py|terms");
        tap(owner, "ap|" + user.chatId);
        payViaMessage(user, {
          currency: "XTR", total_amount: config.psy.stars, invoice_payload: "psy-v1:" + user.chatId,
          telegram_payment_charge_id: "sub_" + user.chatId, subscription_expiration_date: Math.floor((clock.now + 30 * DAY_MS) / 1000),
          is_recurring: true, is_first_recurring: true,
        });
        say(user, "/invite");
        return;
      }
      const code = store.hasUser(user.chatId) && store.user(user.chatId).psy ? store.user(user.chatId).psy.inviteCode : null;
      // Bring one client a day, from the anxious and the trackers.
      if (code && chance(0.6)) {
        const client = pick(people.filter((person) => (person.persona === "anxious" || person.persona === "tracker") &&
          person.started && !person.deleted && !person.psy));
        if (client) {
          say(client, "/start c_" + code);
          tap(client, "cs|yes|" + code);
          tap(client, "cn|" + user.chatId + "|" + (chance(0.5) ? 1 : 0));
          client.psy = user.chatId;
          user.clients.push(client);
        }
      }
      if (chance(0.3)) say(user, "/clients");
      const client = user.clients.length ? pick(user.clients) : null;
      if (client && !client.deleted && chance(0.4)) {
        tap(user, "hw|" + client.chatId);
        say(user, "Щодня записувати три добрі речі і одну техніку дихання.");
        const homework = store.hasUser(client.chatId) ? store.user(client.chatId).homework : [];
        const open = homework.filter((entry) => !entry.doneAt);
        if (open.length && chance(0.6)) tap(client, "hd|" + open[0].id);
      }
      if (client && chance(0.2)) tap(user, "cl|" + client.chatId);
    },
  },
  confused: {
    label: "розгублений",
    day(user) {
      if (!user.started) start(user);
      for (let step = 0; step < between(1, 3); step++) {
        const text = pick(CONFUSED_TEXTS);
        const replies = say(user, text);
        // A greeting brings the two-minute button; some press it.
        if (replies.some((action) => JSON.stringify(keyboardOf(action) || {}).indexOf("s|gad7") !== -1) && chance(0.3)) {
          tap(user, "s|gad7", { freeFeature: "s|gad7" });
          if (sessions.get(user.chatId, clock.now)) {
            sessions.cancel(user.chatId);
            takeTest(user, "gad7", () => between(0, 3));
            skipOrWriteNote(user, "");
          }
        }
      }
      if (chance(0.2)) say(user, pick(["📝 Тести", "⬅️ Головне меню", "🌿 Підтримка", "⚙️ Налаштування"]));
    },
  },
};
const PERSONA_IDS = Object.keys(PERSONAS);

// ---------------------------------------------------------------- people

const people = [];
const owner = { chatId: OWNER, persona: "owner", name: "Олексій", username: "owner_acc", today: 0, startDay: 0, clients: [] };
for (let index = 0; index < USERS; index++) {
  const persona = PERSONA_IDS[index % PERSONA_IDS.length];
  people.push({
    chatId: 100000 + index, persona, name: "Людина" + index, username: "user" + index,
    risky: persona === "depressed" && chance(0.35),
    // Most arrive in the first week; specialists early, so clients exist.
    joinDay: persona === "psychologist" ? between(0, 2) : between(0, 9),
    started: false, startDay: null, tested: false, paid: false, deleted: false, sawPayment: false, gotInvoice: false,
    sawTrialNotice: false, returned: false, lastActiveDay: null, today: 0, clients: [], psy: null,
  });
}

// ---------------------------------------------------------------- the simulation

function deliverUnasked(actions, label) {
  const byChat = new Map();
  actions.forEach((action) => {
    const chatId = action.payload && action.payload.chat_id;
    if (!byChat.has(chatId)) byChat.set(chatId, []);
    byChat.get(chatId).push(action);
  });
  byChat.forEach((list, chatId) => {
    const user = people.find((person) => person.chatId === chatId) || owner;
    check(list, user, {});
    list.forEach((action) => {
      const text = textOf(action);
      if (/закінчується безкоштовний період/.test(text)) user.sawTrialNotice = true;
      // Trackers answer most reminders and accept the daily one; others mostly do not.
      if (/Нагадувати щодня/.test(text) && (user.persona === "tracker" ? chance(0.9) : chance(0.2))) tap(user, "dm|on");
      if (/Як настрій сьогодні/.test(text) && (user.persona === "tracker" ? chance(0.85) : chance(0.2))) {
        tap(user, "m|" + between(3, 9));
      }
    });
  });
  return label;
}

const peopleByChat = new Map(people.map((person) => [person.chatId, person]));
clock.now = START_MS + 6 * 60 * 60000;
say(owner, "/start", { restart: true });

for (let day = 0; day < DAYS; day++) {
  SLOTS_UTC_MINUTES.forEach((minutes, slot) => {
    clock.now = START_MS + day * DAY_MS + minutes * 60000;
    // Each person acts once a day, in the slot their id falls on.
    const order = people.slice().sort(() => random() - 0.5);
    order.forEach((user) => {
      user.today = day;
      if (day < user.joinDay || user.chatId % 3 !== slot) return;
      // Some days some people simply do not come.
      if (user.started && chance(0.25)) return;
      if (user.started && !user.deleted && user.startDay !== null && day === user.startDay + 1) user.returned = true;
      PERSONAS[user.persona].day(user);
    });
    // What the bot sends unasked: daily mood, the trial notice, the offer, the weekly reminder.
    deliverUnasked(router.habitActions(), "habits");
    const due = dueReminders({
      users: store.allUsers().filter((user) => entitlement(user, clock.now).active &&
        !(user.dailyMood && user.dailyMood.unanswered >= 2)),
      nowMs: clock.now, defaults: config.reminder, graceMs: config.reminder.graceMs,
    });
    due.forEach((entry) => {
      const actions = router.reminderActions(entry.chatId, weeklyReminder(store, entry.chatId, entry.schedule));
      store.updateUser(entry.chatId, { lastRemindedAt: entry.dueAt });
      const user = peopleByChat.get(entry.chatId) || owner;
      check(actions, user, {});
    });
  });
}

// The owner's numbers at the end: counts only, never a name.
const statsText = say(owner, "/stats").map(textOf).join("\n");
if (people.some((person) => statsText.indexOf(person.name) !== -1)) violate("a name in /stats", "owner");
if (!/Воронка/.test(statsText)) violate("no funnel in /stats", "owner");

// ---------------------------------------------------------------- report

const rows = PERSONA_IDS.map((id) => {
  const group = people.filter((person) => person.persona === id);
  const count = (predicate) => group.filter(predicate).length;
  return {
    persona: PERSONAS[id].label,
    people: group.length,
    started: count((person) => person.started),
    tested: count((person) => person.tested),
    returned: count((person) => person.returned),
    sawPayment: count((person) => person.sawPayment),
    invoice: count((person) => person.gotInvoice),
    paid: count((person) => person.paid),
  };
});
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) + "%" : "-");
console.log("swarm: " + USERS + " people, " + DAYS + " days, seed " + SEED + ", " + (updateId - 1) + " updates");
console.log("");
console.log(["персонаж".padEnd(14), "людей", "старт", "тест", "повернулися", "оплата показана", "рахунок", "оплатили"].join(" | "));
rows.forEach((row) => {
  console.log([row.persona.padEnd(14), String(row.people).padStart(5), String(row.started).padStart(5),
    (row.tested + " " + pct(row.tested, row.started)).padStart(9),
    (row.returned + " " + pct(row.returned, row.started)).padStart(11),
    (row.sawPayment + " " + pct(row.sawPayment, row.started)).padStart(15),
    String(row.invoice).padStart(7), (row.paid + " " + pct(row.paid, row.started)).padStart(8)].join(" | "));
});
console.log("");
console.log(statsText.split("\n").filter((line) => /Воронка|уперше|перший тест|наступного дня|пропозицію оплати|рахунок|Оплатили/.test(line))
  .map((line) => "  " + line.replace(/<[^>]+>/g, "")).join("\n"));
console.log("");
if (violations.length) {
  console.log("VIOLATIONS: " + Object.keys(violationKinds).map((kind) => kind + " x" + violationKinds[kind]).join(", "));
  violations.forEach((line) => console.log("  " + line));
  process.exit(1);
}
console.log("no violations");
