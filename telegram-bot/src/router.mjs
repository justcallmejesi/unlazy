// Update routing. Zero dependencies. Node 16+.
//
// `handleUpdate` is synchronous and performs no input or output: it reads and
// mutates the in-memory store and returns the Bot API calls to make. That keeps
// every conversational branch testable without a network or a live bot.

import { escapeHtml } from "./telegram.mjs";
import { INSTRUMENT_LIST, buildResult, getInstrument } from "./instruments.mjs";
import {
  formatTimeOfDay, formatUtcOffset, nextDueAfter, parseTimeOfDay, parseUtcOffset, resolveSchedule,
} from "./reminders.mjs";
import {
  aboutText, answerKeyboard, exportMessage, greeting, helpText, historyMessage, lastMessage,
  questionText, reminderStatus, resultMessage, startKeyboard, unknownInput,
} from "./texts.mjs";

const HTML = { parse_mode: "HTML" };
const PRIVATE_ONLY =
  "Опросники доступны только в личном чате с ботом: ответы о самочувствии не стоит публиковать в группе. " +
  "Напишите мне в личные сообщения.";

function send(chatId, text, extra = {}) {
  return { method: "sendMessage", payload: Object.assign({ chat_id: chatId, text }, HTML, extra) };
}

function ack(callbackQueryId, text) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  return { method: "answerCallbackQuery", payload };
}

function editText(chatId, messageId, text) {
  return {
    method: "editMessageText",
    payload: Object.assign({ chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }, HTML),
  };
}

// "/remind@my_bot on" becomes { command: "remind", args: "on" }.
export function parseCommand(text) {
  if (typeof text !== "string") return null;
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { command: match[1].toLowerCase(), mention: match[2] || null, args: (match[3] || "").trim() };
}

export function parseAnswerCallback(data) {
  if (typeof data !== "string") return null;
  const parts = data.split("|");
  if (parts[0] !== "a" || parts.length !== 4) return null;
  const itemIndex = Number(parts[2]);
  const value = Number(parts[3]);
  if (!Number.isInteger(itemIndex) || !Number.isInteger(value)) return null;
  return { sessionId: parts[1], itemIndex, value };
}

export function createRouter(context) {
  const { store, sessions, config } = context;
  const now = typeof context.now === "function" ? context.now : () => Date.now();

  function offsetFor(chatId) {
    return resolveSchedule(store.hasUser(chatId) ? store.user(chatId) : null, config.reminder).offsetMinutes;
  }

  function reminderLine(chatId) {
    const user = store.user(chatId);
    const schedule = resolveSchedule(user, config.reminder);
    return reminderStatus(user, schedule, nextDueAfter(now(), schedule));
  }

  function askCurrent(chatId, instrument, session) {
    return send(chatId, questionText(instrument, session.index, session.total), {
      reply_markup: answerKeyboard(instrument, session),
    });
  }

  function startInstrument(chatId, instrument) {
    const user = store.user(chatId);
    if (!user.firstSeenAt) store.updateUser(chatId, { firstSeenAt: new Date(now()).toISOString() });
    const session = sessions.start(chatId, instrument, now());
    return [
      send(chatId, "<b>" + escapeHtml(instrument.title) + "</b>, " + escapeHtml(instrument.subtitle) +
        ". Вопросов: " + session.total + ". Прервать: /cancel"),
      askCurrent(chatId, instrument, session),
    ];
  }

  function finish(chatId, instrument, session) {
    const completedAt = now();
    const result = buildResult(instrument, session.answers, completedAt);
    const previous = store.lastResult(chatId, instrument.id);
    store.addResult(chatId, result);
    const offsetMinutes = offsetFor(chatId);
    return [send(chatId, resultMessage(instrument, result, previous, offsetMinutes, config.crisisContact), {
      reply_markup: startKeyboard(),
    })];
  }

  // Records one answer and returns the follow-up messages.
  function applyAnswer(chatId, value, expect) {
    const active = sessions.get(chatId, now());
    if (!active) return { actions: [send(chatId, "Активного опросника нет. Запустите /gad7 или /phq9.")], stale: true };
    const instrument = getInstrument(active.instrumentId);
    if (!instrument) {
      sessions.cancel(chatId);
      return { actions: [send(chatId, "Опросник больше не поддерживается. Запустите /gad7 или /phq9.")], stale: true };
    }
    const item = instrument.items[active.index];
    const option = item.options.find((candidate) => candidate.value === Number(value));
    if (!option) {
      return {
        actions: [send(chatId, "Выберите один из вариантов от 0 до " + (item.options.length - 1) + ".")],
        stale: true,
      };
    }
    const outcome = sessions.answer(chatId, option.value, expect, now());
    if (outcome.status !== "recorded") {
      return { actions: [], stale: true, reason: outcome.status };
    }
    if (outcome.done) return { actions: finish(chatId, instrument, outcome.session), option, stale: false };
    return { actions: [askCurrent(chatId, instrument, outcome.session)], option, stale: false };
  }

  function handleRemind(chatId, args) {
    const value = args.toLowerCase();
    if (value === "on" || value === "вкл") {
      store.updateUser(chatId, { remindersEnabled: true });
      return [send(chatId, "Напоминания включены.\n\n" + reminderLine(chatId))];
    }
    if (value === "off" || value === "выкл") {
      store.updateUser(chatId, { remindersEnabled: false });
      return [send(chatId, "Напоминания выключены. Вернуть: /remind on")];
    }
    if (value) {
      const time = parseTimeOfDay(value);
      if (!time) return [send(chatId, "Время нужно в формате ЧЧ:ММ, например /remind 09:30.")];
      // Stored in normal form so the snapshot never holds "9:05".
      store.updateUser(chatId, { reminderTime: formatTimeOfDay(time), remindersEnabled: true });
      return [send(chatId, "Буду напоминать по средам.\n\n" + reminderLine(chatId))];
    }
    return [send(chatId, reminderLine(chatId))];
  }

  function handleTimezone(chatId, args) {
    if (!args) {
      const schedule = resolveSchedule(store.user(chatId), config.reminder);
      return [send(chatId, "Текущий часовой пояс: " + formatUtcOffset(schedule.offsetMinutes) +
        "\nИзменить: /tz +3 или /tz -05:30")];
    }
    const offsetMinutes = parseUtcOffset(args);
    if (offsetMinutes === null) return [send(chatId, "Не понял смещение. Примеры: /tz +3, /tz -05:30, /tz 0.")];
    store.updateUser(chatId, { tzOffsetMinutes: offsetMinutes });
    return [send(chatId, "Часовой пояс сохранён.\n\n" + reminderLine(chatId))];
  }

  function handleCommand(chatId, parsed, message) {
    const { command, args } = parsed;
    switch (command) {
      case "start":
        if (!store.user(chatId).firstSeenAt) {
          store.updateUser(chatId, { firstSeenAt: new Date(now()).toISOString() });
        }
        return [send(chatId, greeting(message && message.from && message.from.first_name), {
          reply_markup: startKeyboard(),
        })];
      case "help":
        return [send(chatId, helpText(), { reply_markup: startKeyboard() })];
      case "about":
        return [send(chatId, aboutText(reminderLine(chatId)))];
      case "gad7":
      case "phq9":
        // Starting a questionnaire always replaces whatever was in progress.
        sessions.cancel(chatId);
        return startInstrument(chatId, getInstrument(command));
      case "cancel":
        return sessions.cancel(chatId)
          ? [send(chatId, "Опросник прерван. Ответы не сохранены.")]
          : [send(chatId, "Нечего прерывать.")];
      case "results":
        return [send(chatId, historyMessage(store, chatId, offsetFor(chatId)), { reply_markup: startKeyboard() })];
      case "last":
        return [send(chatId, lastMessage(store, chatId, offsetFor(chatId)), { reply_markup: startKeyboard() })];
      case "remind":
        return handleRemind(chatId, args);
      case "tz":
        return handleTimezone(chatId, args);
      case "export": {
        const user = store.user(chatId);
        return [send(chatId, exportMessage({
          chatId: user.chatId,
          remindersEnabled: user.remindersEnabled,
          reminderTime: user.reminderTime,
          tzOffsetMinutes: user.tzOffsetMinutes,
          results: user.results,
        }))];
      }
      case "delete":
        return [send(chatId, "Удалить все сохранённые результаты и настройки? Действие необратимо.", {
          reply_markup: {
            inline_keyboard: [[
              { text: "Да, удалить", callback_data: "del|yes" },
              { text: "Отмена", callback_data: "del|no" },
            ]],
          },
        })];
      default:
        return [send(chatId, unknownInput())];
    }
  }

  function handleMessage(message) {
    const chat = message.chat || {};
    const chatId = chat.id;
    if (chatId === undefined || chatId === null) return [];
    const text = typeof message.text === "string" ? message.text : "";
    const parsed = parseCommand(text);
    if (chat.type && chat.type !== "private") {
      return parsed ? [send(chatId, PRIVATE_ONLY)] : [];
    }
    if (parsed) return handleCommand(chatId, parsed, message);
    // A bare 0 to 3 answers the current question, which keeps the bot usable
    // when inline keyboards are unavailable.
    if (/^[0-3]$/.test(text.trim()) && sessions.get(chatId, now())) {
      return applyAnswer(chatId, Number(text.trim()), null).actions;
    }
    if (!text) return [];
    return [send(chatId, unknownInput())];
  }

  function handleCallback(query) {
    const message = query.message || {};
    const chat = message.chat || {};
    const chatId = chat.id;
    const data = typeof query.data === "string" ? query.data : "";
    if (chatId === undefined || chatId === null) return [ack(query.id)];
    if (chat.type && chat.type !== "private") return [ack(query.id), send(chatId, PRIVATE_ONLY)];

    const answer = parseAnswerCallback(data);
    if (answer) {
      const active = sessions.get(chatId, now());
      const instrument = active ? getInstrument(active.instrumentId) : null;
      const askedIndex = answer.itemIndex;
      const outcome = applyAnswer(chatId, answer.value, answer);
      if (outcome.stale) {
        const note = outcome.reason === "stale" ? "Этот вопрос уже отвечен." : undefined;
        return [ack(query.id, note)].concat(outcome.actions);
      }
      const chosen = outcome.option ? escapeHtml(outcome.option.label) : "";
      const replay = instrument && message.message_id
        ? [editText(chatId, message.message_id,
          questionText(instrument, askedIndex, active.total) + "\n\nОтвет: <b>" + chosen + "</b>")]
        : [];
      return [ack(query.id)].concat(replay, outcome.actions);
    }

    const parts = data.split("|");
    if (parts[0] === "s") {
      const instrument = getInstrument(parts[1]);
      if (!instrument) return [ack(query.id, "Неизвестный опросник")];
      if (sessions.get(chatId, now())) sessions.cancel(chatId);
      return [ack(query.id)].concat(startInstrument(chatId, instrument));
    }
    if (parts[0] === "h") {
      return [ack(query.id), send(chatId, historyMessage(store, chatId, offsetFor(chatId)))];
    }
    if (parts[0] === "r") {
      if (parts[1] === "off") return [ack(query.id)].concat(handleRemind(chatId, "off"));
      if (parts[1] === "on") return [ack(query.id)].concat(handleRemind(chatId, "on"));
      return [ack(query.id), send(chatId, reminderLine(chatId))];
    }
    if (parts[0] === "del") {
      if (parts[1] === "yes") {
        sessions.cancel(chatId);
        store.forget(chatId);
        return [ack(query.id, "Удалено"), send(chatId, "Все данные удалены. /start начинает заново.")];
      }
      return [ack(query.id), send(chatId, "Удаление отменено.")];
    }
    return [ack(query.id)];
  }

  function handleUpdate(update) {
    if (!update || typeof update !== "object") return [];
    if (update.message) return handleMessage(update.message);
    if (update.callback_query) return handleCallback(update.callback_query);
    return [];
  }

  function reminderActions(chatId, text) {
    return [send(chatId, text, { reply_markup: startKeyboard() })];
  }

  return { handleUpdate, handleMessage, handleCallback, reminderActions, instruments: INSTRUMENT_LIST };
}
