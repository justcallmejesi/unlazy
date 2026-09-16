// Russian user-facing copy and message formatting. Zero dependencies. Node 16+.
//
// Every dynamic value is escaped before it enters an HTML-parsed message, so a
// display name or a stored answer can never inject markup.

import { escapeHtml } from "./telegram.mjs";
import { INSTRUMENT_LIST, getInstrument, severityOf } from "./instruments.mjs";
import { formatLocalDateTime, formatTimeOfDay, formatUtcOffset } from "./reminders.mjs";

export const DISCLAIMER =
  "Опросники GAD-7 и PHQ-9 это инструменты самонаблюдения, а не диагноз. " +
  "Итоговый балл не заменяет консультацию врача или психотерапевта.";

export const COMMANDS = [
  { command: "gad7", description: "Пройти GAD-7 (тревога, 7 вопросов)" },
  { command: "phq9", description: "Пройти PHQ-9 (настроение, 9 вопросов)" },
  { command: "results", description: "История результатов" },
  { command: "last", description: "Последние результаты" },
  { command: "remind", description: "Напоминания по средам: on, off или ЧЧ:ММ" },
  { command: "tz", description: "Часовой пояс, например /tz +3" },
  { command: "export", description: "Выгрузить мои данные в JSON" },
  { command: "delete", description: "Удалить все мои данные" },
  { command: "cancel", description: "Прервать текущий опросник" },
  { command: "about", description: "О тестах и о том, что бот хранит" },
  { command: "help", description: "Список команд" },
];

export function crisisBlock(crisisContact) {
  return [
    "⚠️ <b>Важно</b>",
    "Вы отметили мысли о смерти или о том, чтобы причинить себе вред. Пожалуйста, не оставайтесь с этим один на один.",
    escapeHtml(crisisContact),
    "Если есть угроза жизни прямо сейчас, звоните в экстренные службы.",
  ].join("\n");
}

export function greeting(name) {
  const hello = name ? "Привет, " + escapeHtml(name) + "!" : "Привет!";
  return [
    hello,
    "",
    "Я помогаю регулярно отслеживать тревогу и настроение по двум коротким опросникам:",
    "• <b>GAD-7</b>: 7 вопросов о тревоге",
    "• <b>PHQ-9</b>: 9 вопросов о настроении, плюс один вопрос о том, как это мешало жить",
    "",
    "Результаты сохраняются, чтобы Вы видели динамику. Каждую среду я напомню пройти тесты снова.",
    "",
    DISCLAIMER,
    "",
    "Команды: /help",
  ].join("\n");
}

export function helpText() {
  const lines = COMMANDS.map((entry) => "/" + entry.command + " " + entry.description);
  return ["<b>Команды</b>", ""].concat(lines).join("\n");
}

export function aboutText(reminderLine) {
  return [
    "<b>Об опросниках</b>",
    "",
    "<b>GAD-7</b>: скрининг генерализованной тревоги. Диапазон 0 до 21 балла.",
    "0 до 4 минимальная, 5 до 9 легкая, 10 до 14 умеренная, 15 до 21 выраженная тревога.",
    "",
    "<b>PHQ-9</b>: скрининг депрессивной симптоматики. Диапазон 0 до 27 баллов.",
    "0 до 4 минимальная, 5 до 9 легкая, 10 до 14 умеренная, 15 до 19 умеренно тяжелая, 20 до 27 тяжелая.",
    "Десятый вопрос о том, насколько симптомы мешали жить, не входит в сумму баллов.",
    "",
    "Балл 10 и выше в любом из опросников принято считать поводом обсудить состояние со специалистом.",
    "",
    "<b>Что хранит бот</b>",
    "Ваш идентификатор чата, ответы и баллы по каждому прохождению, настройки напоминаний.",
    "Данные нужны только для показа динамики. /export выгружает их, /delete удаляет полностью.",
    "",
    reminderLine,
    "",
    DISCLAIMER,
  ].join("\n");
}

export function questionText(instrument, index, sessionTotal) {
  const item = instrument.items[index];
  const lines = ["<b>" + escapeHtml(instrument.title) + "</b> Вопрос " + (index + 1) + " из " + sessionTotal, ""];
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
        { text: "Мои результаты", callback_data: "h|all" },
        { text: "Напоминания", callback_data: "r|status" },
      ],
    ],
  };
}

export function resultMessage(instrument, result, previous, offsetMinutes, crisisContact) {
  const lines = [
    "<b>" + escapeHtml(instrument.title) + " готов</b>",
    "",
    "Баллы: <b>" + result.score + "</b> из " + instrument.maxScore,
    "Оценка: " + escapeHtml(result.severity),
  ];
  if (previous) {
    const delta = result.score - previous.score;
    const sign = delta > 0 ? "+" : "";
    const direction = delta === 0 ? "без изменений" : sign + delta + " к прошлому разу";
    lines.push("Динамика: " + escapeHtml(direction) +
      " (" + previous.score + " от " + formatLocalDateTime(Date.parse(previous.completedAt), offsetMinutes) + ")");
  }
  if (result.impairment !== null && result.impairment !== undefined) {
    const impairmentItem = instrument.items.find((item) => !item.scored);
    const option = impairmentItem.options.find((candidate) => candidate.value === result.impairment);
    if (option) lines.push("Влияние на жизнь: " + escapeHtml(option.label.toLowerCase()));
  }
  lines.push("");
  lines.push(result.aboveCutoff
    ? "Балл выше порога " + instrument.cutoff + ". Это повод обсудить состояние с врачом или психотерапевтом."
    : "Балл ниже порога " + instrument.cutoff + ". Продолжайте наблюдать за динамикой.");
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
      return "<b>" + escapeHtml(instrument.title) + "</b>\nещё нет прохождений: " + instrument.command;
    }
    const rows = entries.map((entry) => {
      const stamp = formatLocalDateTime(Date.parse(entry.completedAt), offsetMinutes);
      const shape = describe(instrument, entry);
      return "• " + stamp + " : <b>" + entry.score + "</b>/" + shape.maxScore +
        " " + escapeHtml(shape.severity);
    });
    const total = store.history(chatId, instrument.id).length;
    const shown = total > entries.length ? "\nпоказаны последние " + entries.length + " из " + total : "";
    return "<b>" + escapeHtml(instrument.title) + "</b>\n" + rows.join("\n") + shown;
  });
  return ["<b>История результатов</b>", ""].concat(sections.join("\n\n")).join("\n");
}

export function lastMessage(store, chatId, offsetMinutes) {
  const rows = INSTRUMENT_LIST.map((instrument) => {
    const entry = store.lastResult(chatId, instrument.id);
    if (!entry) return "<b>" + escapeHtml(instrument.title) + "</b>: нет данных";
    const shape = describe(instrument, entry);
    return "<b>" + escapeHtml(instrument.title) + "</b>: " + entry.score + "/" + shape.maxScore +
      " " + escapeHtml(shape.severity) + ", " + formatLocalDateTime(Date.parse(entry.completedAt), offsetMinutes);
  });
  return ["<b>Последние результаты</b>", ""].concat(rows).join("\n");
}

export function reminderStatus(user, schedule, nextDueMs) {
  const state = user.remindersEnabled ? "включены" : "выключены";
  const lines = [
    "<b>Напоминания</b>: " + state,
    "День: среда, время " + formatTimeOfDay(schedule) + " (" + formatUtcOffset(schedule.offsetMinutes) + ")",
  ];
  if (user.remindersEnabled) {
    lines.push("Следующее: " + formatLocalDateTime(nextDueMs, schedule.offsetMinutes));
  }
  lines.push("");
  lines.push("/remind off выключает, /remind on включает, /remind 09:30 меняет время.");
  lines.push("/tz +3 задаёт часовой пояс.");
  return lines.join("\n");
}

export function weeklyReminder(store, chatId) {
  const rows = INSTRUMENT_LIST.map((instrument) => {
    const entry = store.lastResult(chatId, instrument.id);
    if (!entry) return "• " + instrument.title + ": ещё не проходили";
    return "• " + instrument.title + ": прошлый балл " + entry.score + "/" + describe(instrument, entry).maxScore;
  });
  return ["<b>Среда, время сверки</b>", "", "Пройдите оба опросника, это займёт около двух минут."]
    .concat(rows)
    .concat(["", "Отключить напоминания: /remind off"])
    .join("\n");
}

export function exportMessage(payload) {
  const body = JSON.stringify(payload, null, 2);
  const limit = 3500;
  const clipped = body.length > limit
    ? body.slice(0, limit) + "\n... выгрузка усечена, полные данные в снимке на сервере"
    : body;
  return "<b>Ваши данные</b>\n<pre>" + escapeHtml(clipped) + "</pre>";
}

export function unknownInput() {
  return "Не понял команду. /help показывает список, /gad7 и /phq9 запускают опросники.";
}

export function instrumentTitle(instrumentId) {
  const instrument = getInstrument(instrumentId);
  return instrument ? instrument.title : instrumentId;
}
