// Ukrainian user-facing copy and message formatting. Zero dependencies. Node 16+.
//
// Every dynamic value is escaped before it enters an HTML-parsed message, so a
// display name or a stored answer can never inject markup.

import { escapeHtml } from "./telegram.mjs";
import {
  FREE_INSTRUMENT_LIST, INSTRUMENT_LIST, PAID_INSTRUMENT_LIST, getInstrument, severityOf,
} from "./instruments.mjs";
import { formatLocalDateTime, formatTimeOfDay, formatUtcOffset, offsetAt } from "./reminders.mjs";
import { MAX_NOTE_LENGTH } from "./store.mjs";

// Nominative for naming the day, and the "every Monday" adverb form.
export const WEEKDAY_NAMES = [
  { name: "неділя", every: "щонеділі" },
  { name: "понеділок", every: "щопонеділка" },
  { name: "вівторок", every: "щовівторка" },
  { name: "середа", every: "щосереди" },
  { name: "четвер", every: "щочетверга" },
  { name: "п'ятниця", every: "щоп'ятниці" },
  { name: "субота", every: "щосуботи" },
];

export function weekdayWords(schedule) {
  const index = schedule && Number.isInteger(schedule.weekday) ? schedule.weekday : 1;
  return WEEKDAY_NAMES[((index % 7) + 7) % 7];
}

// Dates are rendered in the offset that was in effect at that very instant, so
// a result taken in summer keeps its summer wall-clock time after the October
// transition.
function stampIn(schedule, timestampMs) {
  return formatLocalDateTime(timestampMs, offsetAt(schedule, timestampMs));
}

export const DISCLAIMER =
  "Опитувальники GAD-7 і PHQ-9 це інструменти самоспостереження, а не діагноз. " +
  "Підсумковий бал не замінює консультацію лікаря або психотерапевта.";

export const COMMANDS = [
  { command: "app", description: "Відкрити застосунок у вікні" },
  { command: "gad7", description: "Пройти GAD-7 (тривога, 7 питань)" },
  { command: "phq9", description: "Пройти PHQ-9 (настрій, 9 питань)" },
  { command: "isi", description: "Пройти ISI (сон, 7 питань)" },
  { command: "stress", description: "Пройти PSS-10 (стрес, 10 питань)" },
  { command: "results", description: "Історія результатів (повний доступ)" },
  { command: "last", description: "Останні результати (повний доступ)" },
  { command: "remind", description: "Нагадування (повний доступ)" },
  { command: "tz", description: "Часовий пояс: auto або, наприклад, /tz +3" },
  { command: "export", description: "Вивантажити мої дані у JSON" },
  { command: "delete", description: "Видалити всі мої дані" },
  { command: "cancel", description: "Перервати поточний опитувальник" },
  { command: "buy", description: "Повний доступ: шкали сну і стресу" },
  { command: "paysupport", description: "Питання щодо оплати і повернення" },
  { command: "about", description: "Про тести і про те, що зберігає бот" },
  { command: "help", description: "Список команд" },
];

export function crisisBlock(crisisContact) {
  return [
    "⚠️ <b>Важливо</b>",
    "Ви позначили думки про смерть або про те, щоб завдати собі шкоди. Будь ласка, не залишайтеся з цим наодинці.",
    escapeHtml(crisisContact),
    "Якщо є загроза життю прямо зараз, телефонуйте до екстрених служб.",
  ].join("\n");
}

export function greeting(name, schedule, options = {}) {
  const hello = name ? "Привіт, " + escapeHtml(name) + "!" : "Привіт!";
  const words = weekdayWords(schedule);
  const extra = options.extra || "";
  return [
    hello,
    "",
    "Я допомагаю регулярно відстежувати стан за короткими опитувальниками:",
    "• <b>GAD-7</b>: 7 питань про тривогу",
    "• <b>PHQ-9</b>: 9 питань про настрій, плюс одне питання про те, як це ускладнювало життя",
    "• <b>ISI</b>: 7 питань про сон",
    "• <b>PSS-10</b>: 10 питань про стрес за останній місяць",
    "",
    options.remindersActive
      ? "Результати зберігаються, щоб Ви бачили динаміку. " +
        escapeHtml(words.every.charAt(0).toUpperCase() + words.every.slice(1)) + " я нагадаю пройти тести знову."
      : "Результати зберігаються. Історія, статистика і щотижневе нагадування входять у повний доступ.",
    "",
    DISCLAIMER,
    extra ? "" : null,
    extra || null,
    "",
    "Команди: /help",
  ].filter((line) => line !== null).join("\n");
}

export function helpText() {
  const lines = COMMANDS.map((entry) => "/" + entry.command + " " + entry.description);
  return ["<b>Команди</b>", ""].concat(lines).join("\n");
}

export function aboutText(reminderLine) {
  return [
    "<b>Про опитувальники</b>",
    "",
    "<b>GAD-7</b>: скринінг генералізованої тривоги. Діапазон від 0 до 21 бала.",
    "0 до 4 мінімальна, 5 до 9 легка, 10 до 14 помірна, 15 до 21 виражена тривога.",
    "",
    "<b>PHQ-9</b>: скринінг депресивної симптоматики. Діапазон від 0 до 27 балів.",
    "0 до 4 мінімальні, 5 до 9 легкі, 10 до 14 помірні, 15 до 19 помірно тяжкі, 20 до 27 тяжкі прояви.",
    "Десяте питання про те, наскільки симптоми ускладнювали життя, не входить у суму балів.",
    "",
    "Бал 10 і вище в GAD-7 або PHQ-9 прийнято вважати підставою обговорити стан із фахівцем.",
    "",
    "<b>ISI</b>: індекс тяжкості безсоння. Діапазон від 0 до 28 балів.",
    "0 до 7 без клінічно значущого безсоння, 8 до 14 підпорогове, 15 до 21 помірне, 22 до 28 тяжке.",
    "",
    "<b>PSS-10</b>: шкала відчутного стресу за останній місяць. Діапазон від 0 до 40 балів.",
    "0 до 13 низький, 14 до 26 помірний, 27 до 40 високий стрес. Чотири питання враховуються навпаки: " +
      "відчуття контролю знижує підсумковий бал.",
    "",
    "<b>Що зберігає бот</b>",
    "Ваш ідентифікатор чату, відповіді та бали кожного проходження, налаштування нагадувань.",
    "Дані потрібні лише для показу динаміки. /export вивантажує їх, /delete видаляє повністю.",
    "",
    reminderLine,
    "",
    DISCLAIMER,
  ].join("\n");
}

function starWord(stars) {
  const last = stars % 10;
  const tens = stars % 100;
  if (tens >= 11 && tens <= 14) return "зірок";
  if (last === 1) return "зірка";
  if (last >= 2 && last <= 4) return "зірки";
  return "зірок";
}

export function priceLine(price) {
  return price.stars + " " + starWord(price.stars) + " одноразово, без підписки";
}

export function trialNotice(entitlementState, price) {
  if (entitlementState.kind !== "trial") return "";
  return "Безкоштовний період: залишилося днів " + entitlementState.daysLeft +
    ". Далі повний доступ коштує " + priceLine(price) + ".";
}

// Shown when a locked feature is asked for. Says plainly what stays free.
export function paywall(price, entitlementState) {
  const lines = ["<b>Повний доступ</b>", ""];
  if (entitlementState.kind === "expired") {
    lines.push("Безкоштовний період закінчився.");
  } else {
    lines.push("Ця частина входить у повний доступ.");
  }
  lines.push("");
  lines.push("<b>Що відкривається</b>");
  PAID_INSTRUMENT_LIST.forEach((instrument) => {
    lines.push("• " + escapeHtml(instrument.title) + ": " + escapeHtml(instrument.subtitle));
  });
  lines.push("• історія всіх проходжень і статистика з графіками");
  lines.push("• щотижневе нагадування і його налаштування");
  lines.push("");
  lines.push("<b>Що назавжди безкоштовно</b>");
  FREE_INSTRUMENT_LIST.forEach((instrument) => {
    lines.push("• " + escapeHtml(instrument.title) + ": " + escapeHtml(instrument.subtitle) + ", сам тест і результат");
  });
  lines.push("• блок підтримки, якщо в PHQ-9 позначено ризик");
  lines.push("• /export і /delete: Ваші дані завжди Ваші");
  lines.push("");
  lines.push("Ціна: <b>" + escapeHtml(priceLine(price)) + "</b>. Оплата зірками Telegram.");
  return lines.join("\n");
}

export function buyKeyboard(price) {
  return {
    inline_keyboard: [[{
      text: "Відкрити повний доступ за " + price.stars + " " + starWord(price.stars),
      callback_data: "pay|start",
    }]],
  };
}

export function purchaseThanks(price) {
  return [
    "Дякую, повний доступ відкрито назавжди.",
    "",
    "Тепер доступні " + PAID_INSTRUMENT_LIST.map((instrument) => instrument.title).join(" і ") +
      ", повна історія і статистика за всіма шкалами.",
    "",
    "Питання щодо оплати: /paysupport",
  ].join("\n");
}

export function alreadyPro() {
  return "Повний доступ уже відкритий. Дякую, що підтримали бота.";
}

export function lockedFeature(name) {
  return name;
}

export function paySupport(price) {
  return [
    "<b>Оплата і повернення</b>",
    "",
    "Повний доступ це одноразова покупка за " + escapeHtml(priceLine(price)) + ". Підписки немає, " +
      "нічого не списується повторно.",
    "",
    "Повернення можливе протягом 14 днів: напишіть тут, і я поверну зірки через Telegram. " +
      "Після повернення платні шкали закриються, а Ваші результати залишаться.",
    "",
    "Опитувальники GAD-7 і PHQ-9, щотижневе нагадування, блок підтримки, вивантаження і видалення " +
      "даних працюють безкоштовно і після повернення.",
  ].join("\n");
}

export function questionText(instrument, index, sessionTotal) {
  const item = instrument.items[index];
  const lines = ["<b>" + escapeHtml(instrument.title) + "</b> Питання " + (index + 1) + " з " + sessionTotal, ""];
  // The unscored impairment item carries its own framing, so the shared
  // "last two weeks" prompt is only repeated above the scored items.
  if (item.scored) lines.push(escapeHtml(instrument.prompt), "");
  lines.push("<b>" + escapeHtml(item.text) + "</b>");
  return lines.join("\n");
}

export function answerKeyboard(instrument, session) {
  const item = instrument.items[session.index];
  return {
    inline_keyboard: item.options.map((option) => [{
      text: option.value + " " + option.label,
      callback_data: ["a", session.id, session.index, option.value].join("|"),
    }]),
  };
}

// The one full-width button under the input field. A keyboard button is the
// only launch type whose Mini App can send data back without a server, so this
// is what the app is opened from.
export function appKeyboard(webappUrl) {
  return {
    keyboard: [[{ text: "Відкрити застосунок", web_app: { url: webappUrl } }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function appIntro() {
  return [
    "<b>Застосунок</b>",
    "",
    "Кнопка «Відкрити застосунок» під полем введення відкриває вікно поверх чату.",
    "Там опитувальники, статистика з графіками, історія, нагадування і ваші дані.",
    "",
    "У чат приходить лише підсумок кожного проходження. Опитувальники так само працюють і тут, командами /gad7 та /phq9.",
  ].join("\n");
}

export function appResultSaved(instrument, result) {
  return "Збережено із застосунку: <b>" + escapeHtml(instrument.title) + "</b> " +
    result.score + "/" + instrument.maxScore + ", " + escapeHtml(result.severity) + ".";
}

export function appRejected() {
  return "Не вдалося прочитати дані із застосунку. Спробуйте ще раз або пройдіть опитувальник у чаті: /gad7, /phq9.";
}

export function startKeyboard(unlocked = true) {
  const paidRow = PAID_INSTRUMENT_LIST.map((instrument) => ({
    text: unlocked ? instrument.title : instrument.title + " 🔒",
    callback_data: "s|" + instrument.id,
  }));
  return {
    inline_keyboard: [
      FREE_INSTRUMENT_LIST.map((instrument) => ({
        text: instrument.title,
        callback_data: "s|" + instrument.id,
      })),
      paidRow,
      [
        { text: "Мої результати", callback_data: "h|all" },
        { text: "Нагадування", callback_data: "r|status" },
      ],
    ],
  };
}

export function resultMessage(instrument, result, previous, schedule, crisisContact) {
  const lines = [
    "<b>" + escapeHtml(instrument.title) + " готовий</b>",
    "",
    "Бали: <b>" + result.score + "</b> з " + instrument.maxScore,
    "Оцінка: " + escapeHtml(result.severity),
  ];
  if (previous) {
    const delta = result.score - previous.score;
    const sign = delta > 0 ? "+" : "";
    const direction = delta === 0 ? "без змін" : sign + delta + " до минулого разу";
    lines.push("Динаміка: " + escapeHtml(direction) +
      " (" + previous.score + " від " + stampIn(schedule, Date.parse(previous.completedAt)) + ")");
  }
  if (result.impairment !== null && result.impairment !== undefined) {
    const impairmentItem = instrument.items.find((item) => !item.scored);
    const option = impairmentItem.options.find((candidate) => candidate.value === result.impairment);
    if (option) lines.push("Вплив на життя: " + escapeHtml(option.label.toLowerCase()));
  }
  lines.push("");
  lines.push(result.aboveCutoff
    ? "Бал вище порогу " + instrument.cutoff + ". Це підстава обговорити стан із лікарем або психотерапевтом."
    : "Бал нижче порогу " + instrument.cutoff + ". Продовжуйте спостерігати за динамікою.");
  if (result.risk) {
    lines.push("");
    lines.push(crisisBlock(crisisContact));
  }
  lines.push("");
  lines.push(DISCLAIMER);
  return lines.join("\n");
}

// A snapshot edited by hand can omit the derived fields, so both are recomputed
// from the score when they are missing.
function describe(instrument, entry) {
  const maxScore = Number.isFinite(entry.maxScore) ? entry.maxScore : instrument.maxScore;
  const severity = typeof entry.severity === "string" ? entry.severity : severityOf(instrument, entry.score);
  return { maxScore, severity };
}

// The one open question, asked after the scored items. It is not scored and
// exists so a number has a story next to it a month later.
export function noteQuestion() {
  return [
    "<b>І останнє, вільними словами</b>",
    "",
    "Яким був цей тиждень? Що впливало на стан, що допомагало, а що виснажувало.",
    "Кілька речень достатньо, можна й одне.",
    "",
    "Це не оцінюється і на бали не впливає. Саме ці рядки через місяць пояснять, чому бал був таким.",
    "",
    "Напишіть відповідь одним повідомленням або натисніть «Пропустити».",
  ].join("\n");
}

export function noteKeyboard(pendingId) {
  return { inline_keyboard: [[{ text: "Пропустити", callback_data: "n|" + pendingId + "|skip" }]] };
}

export function noteSaved(note) {
  const shortened = note.length >= MAX_NOTE_LENGTH
    ? "\n\nЗапис довгий, тому збережені перші " + MAX_NOTE_LENGTH + " символів."
    : "";
  return "Записав, опис збережено разом із результатом. Побачити його знову: /results" + shortened;
}

export function noteSkipped() {
  return "Гаразд, без опису. Результат уже збережено.";
}

// One line for a list, never the whole note.
function noteSnippet(note, limit = 90) {
  const flat = note.replace(/\s+/g, " ").trim();
  return escapeHtml(flat.length > limit ? flat.slice(0, limit) + "..." : flat);
}

export function historyMessage(store, chatId, schedule, limit = 10) {
  const sections = INSTRUMENT_LIST.map((instrument) => {
    const entries = store.history(chatId, instrument.id, limit);
    if (!entries.length) {
      return "<b>" + escapeHtml(instrument.title) + "</b>\nще немає проходжень: " + instrument.command;
    }
    const rows = entries.map((entry) => {
      const stamp = stampIn(schedule, Date.parse(entry.completedAt));
      const shape = describe(instrument, entry);
      const row = "• " + stamp + " : <b>" + entry.score + "</b>/" + shape.maxScore +
        " " + escapeHtml(shape.severity);
      return entry.note ? row + "\n  <i>" + noteSnippet(entry.note) + "</i>" : row;
    });
    const total = store.history(chatId, instrument.id).length;
    const shown = total > entries.length ? "\nпоказані останні " + entries.length + " з " + total : "";
    return "<b>" + escapeHtml(instrument.title) + "</b>\n" + rows.join("\n") + shown;
  });
  return ["<b>Історія результатів</b>", ""].concat(sections.join("\n\n")).join("\n");
}

export function lastMessage(store, chatId, schedule) {
  const rows = INSTRUMENT_LIST.map((instrument) => {
    const entry = store.lastResult(chatId, instrument.id);
    if (!entry) return "<b>" + escapeHtml(instrument.title) + "</b>: немає даних";
    const shape = describe(instrument, entry);
    const head = "<b>" + escapeHtml(instrument.title) + "</b>: " + entry.score + "/" + shape.maxScore +
      " " + escapeHtml(shape.severity) + ", " + stampIn(schedule, Date.parse(entry.completedAt));
    return entry.note ? head + "\n<i>" + escapeHtml(entry.note) + "</i>" : head;
  });
  return ["<b>Останні результати</b>", ""].concat(rows).join("\n");
}

export function reminderStatus(user, schedule, nextDueMs) {
  const state = user.remindersEnabled ? "увімкнені" : "вимкнені";
  const offsetNow = offsetAt(schedule, nextDueMs);
  const zoneNote = schedule.zone
    ? escapeHtml(schedule.zone) + ", зараз " + formatUtcOffset(offsetNow) + ", перехід на літній час враховується"
    : formatUtcOffset(offsetNow) + ", фіксований зсув";
  const lines = [
    "<b>Нагадування</b>: " + state,
    "День: " + weekdayWords(schedule).name + ", час " + formatTimeOfDay(schedule),
    "Часовий пояс: " + zoneNote,
  ];
  if (user.remindersEnabled) {
    lines.push("Наступне: " + formatLocalDateTime(nextDueMs, offsetNow));
  }
  lines.push("");
  lines.push("/remind off вимикає, /remind on вмикає, /remind 20:30 змінює час.");
  lines.push("/tz +3 задає свій зсув, /tz auto повертає автоматичний.");
  return lines.join("\n");
}

export function weeklyReminder(store, chatId, schedule) {
  const rows = INSTRUMENT_LIST.map((instrument) => {
    const entry = store.lastResult(chatId, instrument.id);
    if (!entry) return "• " + instrument.title + ": ще не проходили";
    return "• " + instrument.title + ": минулий бал " + entry.score + "/" + describe(instrument, entry).maxScore;
  });
  const day = weekdayWords(schedule).name;
  return ["<b>" + escapeHtml(day.charAt(0).toUpperCase() + day.slice(1)) + ", час для перевірки</b>", "",
    "Пройдіть обидва опитувальники, це займе близько двох хвилин."]
    .concat(rows)
    .concat(["", "Вимкнути нагадування: /remind off"])
    .join("\n");
}

export function exportMessage(payload) {
  const body = JSON.stringify(payload, null, 2);
  const limit = 3500;
  const clipped = body.length > limit
    ? body.slice(0, limit) + "\n... вивантаження скорочено, повні дані у знімку на сервері"
    : body;
  return "<b>Ваші дані</b>\n<pre>" + escapeHtml(clipped) + "</pre>";
}

export function unknownInput() {
  return "Не зрозумів команду. /help показує список, /gad7 і /phq9 запускають опитувальники.";
}

export function instrumentTitle(instrumentId) {
  const instrument = getInstrument(instrumentId);
  return instrument ? instrument.title : instrumentId;
}
