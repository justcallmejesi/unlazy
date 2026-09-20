// Ukrainian user-facing copy and message formatting. Zero dependencies. Node 16+.
//
// Every dynamic value is escaped before it enters an HTML-parsed message, so a
// display name or a stored answer can never inject markup.

import { escapeHtml } from "./telegram.mjs";
import { INSTRUMENT_LIST, getInstrument, severityOf } from "./instruments.mjs";
import { formatLocalDateTime, formatTimeOfDay, formatUtcOffset } from "./reminders.mjs";

export const DISCLAIMER =
  "Опитувальники GAD-7 і PHQ-9 це інструменти самоспостереження, а не діагноз. " +
  "Підсумковий бал не замінює консультацію лікаря або психотерапевта.";

export const COMMANDS = [
  { command: "gad7", description: "Пройти GAD-7 (тривога, 7 питань)" },
  { command: "phq9", description: "Пройти PHQ-9 (настрій, 9 питань)" },
  { command: "results", description: "Історія результатів" },
  { command: "last", description: "Останні результати" },
  { command: "remind", description: "Нагадування щосереди: on, off або ГГ:ХХ" },
  { command: "tz", description: "Часовий пояс, наприклад /tz +3" },
  { command: "export", description: "Вивантажити мої дані у JSON" },
  { command: "delete", description: "Видалити всі мої дані" },
  { command: "cancel", description: "Перервати поточний опитувальник" },
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

export function greeting(name) {
  const hello = name ? "Привіт, " + escapeHtml(name) + "!" : "Привіт!";
  return [
    hello,
    "",
    "Я допомагаю регулярно відстежувати тривогу і настрій за двома короткими опитувальниками:",
    "• <b>GAD-7</b>: 7 питань про тривогу",
    "• <b>PHQ-9</b>: 9 питань про настрій, плюс одне питання про те, як це ускладнювало життя",
    "",
    "Результати зберігаються, щоб Ви бачили динаміку. Щосереди я нагадаю пройти тести знову.",
    "",
    DISCLAIMER,
    "",
    "Команди: /help",
  ].join("\n");
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
    "Бал 10 і вище в будь-якому з опитувальників прийнято вважати підставою обговорити стан із фахівцем.",
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

export function startKeyboard() {
  return {
    inline_keyboard: [
      INSTRUMENT_LIST.map((instrument) => ({
        text: instrument.title,
        callback_data: "s|" + instrument.id,
      })),
      [
        { text: "Мої результати", callback_data: "h|all" },
        { text: "Нагадування", callback_data: "r|status" },
      ],
    ],
  };
}

export function resultMessage(instrument, result, previous, offsetMinutes, crisisContact) {
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
      " (" + previous.score + " від " + formatLocalDateTime(Date.parse(previous.completedAt), offsetMinutes) + ")");
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

export function historyMessage(store, chatId, offsetMinutes, limit = 10) {
  const sections = INSTRUMENT_LIST.map((instrument) => {
    const entries = store.history(chatId, instrument.id, limit);
    if (!entries.length) {
      return "<b>" + escapeHtml(instrument.title) + "</b>\nще немає проходжень: " + instrument.command;
    }
    const rows = entries.map((entry) => {
      const stamp = formatLocalDateTime(Date.parse(entry.completedAt), offsetMinutes);
      const shape = describe(instrument, entry);
      return "• " + stamp + " : <b>" + entry.score + "</b>/" + shape.maxScore +
        " " + escapeHtml(shape.severity);
    });
    const total = store.history(chatId, instrument.id).length;
    const shown = total > entries.length ? "\nпоказані останні " + entries.length + " з " + total : "";
    return "<b>" + escapeHtml(instrument.title) + "</b>\n" + rows.join("\n") + shown;
  });
  return ["<b>Історія результатів</b>", ""].concat(sections.join("\n\n")).join("\n");
}

export function lastMessage(store, chatId, offsetMinutes) {
  const rows = INSTRUMENT_LIST.map((instrument) => {
    const entry = store.lastResult(chatId, instrument.id);
    if (!entry) return "<b>" + escapeHtml(instrument.title) + "</b>: немає даних";
    const shape = describe(instrument, entry);
    return "<b>" + escapeHtml(instrument.title) + "</b>: " + entry.score + "/" + shape.maxScore +
      " " + escapeHtml(shape.severity) + ", " + formatLocalDateTime(Date.parse(entry.completedAt), offsetMinutes);
  });
  return ["<b>Останні результати</b>", ""].concat(rows).join("\n");
}

export function reminderStatus(user, schedule, nextDueMs) {
  const state = user.remindersEnabled ? "увімкнені" : "вимкнені";
  const lines = [
    "<b>Нагадування</b>: " + state,
    "День: середа, час " + formatTimeOfDay(schedule) + " (" + formatUtcOffset(schedule.offsetMinutes) + ")",
  ];
  if (user.remindersEnabled) {
    lines.push("Наступне: " + formatLocalDateTime(nextDueMs, schedule.offsetMinutes));
  }
  lines.push("");
  lines.push("/remind off вимикає, /remind on вмикає, /remind 09:30 змінює час.");
  lines.push("/tz +3 задає часовий пояс.");
  return lines.join("\n");
}

export function weeklyReminder(store, chatId) {
  const rows = INSTRUMENT_LIST.map((instrument) => {
    const entry = store.lastResult(chatId, instrument.id);
    if (!entry) return "• " + instrument.title + ": ще не проходили";
    return "• " + instrument.title + ": минулий бал " + entry.score + "/" + describe(instrument, entry).maxScore;
  });
  return ["<b>Середа, час для перевірки</b>", "", "Пройдіть обидва опитувальники, це займе близько двох хвилин."]
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
