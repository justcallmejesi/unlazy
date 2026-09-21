// Update routing. User-facing text is Ukrainian. Zero dependencies. Node 16+.
//
// `handleUpdate` is synchronous and performs no input or output: it reads and
// mutates the in-memory store and returns the Bot API calls to make. That keeps
// every conversational branch testable without a network or a live bot.

import { escapeHtml } from "./telegram.mjs";
import { INSTRUMENT_LIST, buildResult, getInstrument } from "./instruments.mjs";
import { applyPayment, checkPreCheckout, ensureTrial, entitlement, invoiceFor } from "./billing.mjs";
import {
  formatTimeOfDay, nextDueAfter, parseTimeOfDay, parseUtcOffset, resolveSchedule,
} from "./reminders.mjs";
import {
  aboutText, answerKeyboard, appIntro, appKeyboard, appRejected, appResultSaved, exportMessage,
  greeting, helpText, historyMessage, lastMessage, noteKeyboard, noteQuestion, noteSaved,
  noteSkipped, questionText, reminderStatus, resultMessage, startKeyboard, unknownInput,
  alreadyPro, buyKeyboard, paySupport, paywall, purchaseThanks, trialNotice, weekdayWords,
} from "./texts.mjs";
import { parseWebAppPayload } from "./webapp.mjs";

const HTML = { parse_mode: "HTML" };
// Commands that start a questionnaire, mapped to their instrument.
const INSTRUMENT_COMMANDS = {};
INSTRUMENT_LIST.forEach((instrument) => { INSTRUMENT_COMMANDS[instrument.command.slice(1)] = instrument; });
const PRIVATE_ONLY =
  "Опитувальники доступні лише в особистому чаті з ботом: відповіді про самопочуття не варто публікувати в групі. " +
  "Напишіть мені в особисті повідомлення.";

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

  // The schedule, not a bare offset: it carries the weekday, the time and
  // either a zone or a fixed offset, and dates resolve their own offset.
  function appUrl(state) {
    if (!config.webappUrl) return null;
    const separator = config.webappUrl.indexOf("?") === -1 ? "?" : "&";
    return config.webappUrl + separator + "pro=" + (state.active ? "1" : "0");
  }

  function scheduleFor(chatId) {
    return resolveSchedule(store.hasUser(chatId) ? store.user(chatId) : null, config.reminder);
  }

  function access(chatId) {
    return entitlement(store.hasUser(chatId) ? store.user(chatId) : null, now());
  }

  function startTrialFor(chatId) {
    return ensureTrial(store, chatId, now(), config.price.trialDays);
  }

  function locked(chatId, state) {
    return [send(chatId, paywall(config.price, state), { reply_markup: buyKeyboard(config.price) })];
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
    startTrialFor(chatId);
    const state = access(chatId);
    // The two screening scales are always free; sleep and stress are not.
    if (instrument.paid && !state.active) return locked(chatId, state);
    const session = sessions.start(chatId, instrument, now());
    return [
      send(chatId, "<b>" + escapeHtml(instrument.title) + "</b>, " + escapeHtml(instrument.subtitle) +
        ". Питань: " + session.total + ". Перервати: /cancel"),
      askCurrent(chatId, instrument, session),
    ];
  }

  // The score is stored before the open question is asked, so a person who
  // never writes anything still keeps the result.
  function finish(chatId, instrument, session) {
    const completedAt = now();
    const result = buildResult(instrument, session.answers, completedAt);
    const previous = store.lastResult(chatId, instrument.id);
    const stored = store.addResult(chatId, result);
    const pending = sessions.expectNote(chatId, instrument.id, stored, now());
    const schedule = scheduleFor(chatId);
    return [
      send(chatId, resultMessage(instrument, result, previous, schedule, config.crisisContact)),
      send(chatId, noteQuestion(), { reply_markup: noteKeyboard(pending.id) }),
    ];
  }

  function acceptNote(chatId, text) {
    const pending = sessions.pendingNote(chatId, now());
    if (!pending) return [];
    sessions.clearNote(chatId);
    const annotated = store.annotateResult(chatId, pending.result, text);
    // The result can be gone: /delete, or 200 newer runs pushing it out.
    const unlocked = access(chatId).active;
    if (!annotated || !annotated.note) {
      return [send(chatId, noteSkipped(), { reply_markup: startKeyboard(unlocked) })];
    }
    return [send(chatId, noteSaved(annotated.note), { reply_markup: startKeyboard(unlocked) })];
  }

  // Records one answer and returns the follow-up messages.
  function applyAnswer(chatId, value, expect) {
    const active = sessions.get(chatId, now());
    if (!active) return { actions: [send(chatId, "Активного опитувальника немає. Запустіть /gad7 або /phq9.")], stale: true };
    const instrument = getInstrument(active.instrumentId);
    if (!instrument) {
      sessions.cancel(chatId);
      return { actions: [send(chatId, "Опитувальник більше не підтримується. Запустіть /gad7 або /phq9.")], stale: true };
    }
    const item = instrument.items[active.index];
    const option = item.options.find((candidate) => candidate.value === Number(value));
    if (!option) {
      return {
        actions: [send(chatId, "Виберіть один із варіантів від 0 до " + (item.options.length - 1) + ".")],
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
    if (value === "on" || value === "увімк") {
      store.updateUser(chatId, { remindersEnabled: true });
      return [send(chatId, "Нагадування увімкнені.\n\n" + reminderLine(chatId))];
    }
    if (value === "off" || value === "вимк") {
      store.updateUser(chatId, { remindersEnabled: false });
      return [send(chatId, "Нагадування вимкнені. Повернути: /remind on")];
    }
    if (value) {
      const time = parseTimeOfDay(value);
      if (!time) return [send(chatId, "Час потрібен у форматі ГГ:ХХ, наприклад /remind 09:30.")];
      // Stored in normal form so the snapshot never holds "9:05".
      store.updateUser(chatId, { reminderTime: formatTimeOfDay(time), remindersEnabled: true });
      return [send(chatId, "Нагадуватиму " + weekdayWords(scheduleFor(chatId)).every + ".\n\n" +
        reminderLine(chatId))];
    }
    return [send(chatId, reminderLine(chatId))];
  }

  function handleTimezone(chatId, args) {
    if (!args) return [send(chatId, reminderLine(chatId) +
      "\n\nВласний зсув: /tz +3 або /tz -05:30. Повернути автоматичний: /tz auto.")];
    if (/^(auto|авто)$/i.test(args)) {
      if (!config.reminder.zone) {
        return [send(chatId, "Автоматичний режим недоступний: сервер налаштований на фіксований зсув.")];
      }
      store.updateUser(chatId, { tzOffsetMinutes: null });
      return [send(chatId, "Повернув автоматичний часовий пояс.\n\n" + reminderLine(chatId))];
    }
    const offsetMinutes = parseUtcOffset(args);
    if (offsetMinutes === null) {
      return [send(chatId, "Не зрозумів зсув. Приклади: /tz +3, /tz -05:30, /tz 0, /tz auto.")];
    }
    store.updateUser(chatId, { tzOffsetMinutes: offsetMinutes });
    return [send(chatId, "Зсув збережено. Він фіксований, переходи на літній час не враховуються.\n\n" +
      reminderLine(chatId))];
  }

  function handleCommand(chatId, parsed, message) {
    const { command, args } = parsed;
    if (Object.prototype.hasOwnProperty.call(INSTRUMENT_COMMANDS, command)) {
      // Starting a questionnaire always replaces whatever was in progress.
      sessions.cancel(chatId);
      sessions.clearNote(chatId);
      return startInstrument(chatId, INSTRUMENT_COMMANDS[command]);
    }
    switch (command) {
      case "start": {
        if (!store.user(chatId).firstSeenAt) {
          store.updateUser(chatId, { firstSeenAt: new Date(now()).toISOString() });
        }
        startTrialFor(chatId);
        const state = access(chatId);
        const hello = send(chatId,
          greeting(message && message.from && message.from.first_name, scheduleFor(chatId),
            { extra: trialNotice(state, config.price), remindersActive: state.active }),
          { reply_markup: config.webappUrl ? appKeyboard(appUrl(state)) : startKeyboard(state.active) });
        // Without the app the chat flow is the whole product, so the inline
        // start buttons stay the entry point.
        return config.webappUrl ? [hello, send(chatId, appIntro())] : [hello];
      }
      case "app":
        if (!config.webappUrl) {
          return [send(chatId, "Застосунок не налаштований. Опитувальники доступні тут: /gad7, /phq9.")];
        }
        startTrialFor(chatId);
        return [send(chatId, appIntro(), { reply_markup: appKeyboard(appUrl(access(chatId))) })];
      case "help":
        return [send(chatId, helpText(), { reply_markup: startKeyboard(access(chatId).active) })];
      case "about":
        return [send(chatId, aboutText(reminderLine(chatId)))];
      case "buy": {
        startTrialFor(chatId);
        const state = access(chatId);
        if (state.kind === "pro") return [send(chatId, alreadyPro())];
        return locked(chatId, state);
      }
      case "paysupport":
        return [send(chatId, paySupport(config.price))];
      case "cancel": {
        const hadSession = sessions.cancel(chatId);
        const hadNote = sessions.clearNote(chatId);
        if (hadSession) return [send(chatId, "Опитувальник перервано. Відповіді не збережені.")];
        if (hadNote) return [send(chatId, noteSkipped(), { reply_markup: startKeyboard(access(chatId).active) })];
        return [send(chatId, "Немає чого перервати.")];
      }
      case "results": {
        const state = access(chatId);
        if (!state.active) return locked(chatId, state);
        return [send(chatId, historyMessage(store, chatId, scheduleFor(chatId)),
          { reply_markup: startKeyboard(true) })];
      }
      case "last": {
        const state = access(chatId);
        if (!state.active) return locked(chatId, state);
        return [send(chatId, lastMessage(store, chatId, scheduleFor(chatId)),
          { reply_markup: startKeyboard(true) })];
      }
      case "remind": {
        const state = access(chatId);
        // The weekly reminder itself is part of the full access, so its
        // settings are too.
        if (!state.active) return locked(chatId, state);
        return handleRemind(chatId, args);
      }
      case "tz": {
        const state = access(chatId);
        if (!state.active) return locked(chatId, state);
        return handleTimezone(chatId, args);
      }
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
        return [send(chatId, "Видалити всі збережені результати та налаштування? Дію не можна скасувати.", {
          reply_markup: {
            inline_keyboard: [[
              { text: "Так, видалити", callback_data: "del|yes" },
              { text: "Скасувати", callback_data: "del|no" },
            ]],
          },
        })];
      default:
        return [send(chatId, unknownInput())];
    }
  }

  // Data returned by the Mini App. The answers are rescored here: the payload
  // carries no score, and nothing from the client is stored unvalidated.
  function handleWebAppData(chatId, raw) {
    const parsed = parseWebAppPayload(raw);
    if (!parsed.ok) return { actions: [send(chatId, appRejected())], reason: parsed.reason };
    const payload = parsed.payload;

    if (payload.type === "result") {
      const instrument = getInstrument(payload.instrumentId);
      startTrialFor(chatId);
      const state = access(chatId);
      // The window is only a hint about what is unlocked; this is the check
      // that actually decides, so an edited client changes nothing.
      if (instrument.paid && !state.active) {
        return { actions: locked(chatId, state), payload, rejected: "locked" };
      }
      const result = buildResult(instrument, payload.answers, now());
      const previous = store.lastResult(chatId, instrument.id);
      const stored = store.addResult(chatId, result);
      if (payload.note) store.annotateResult(chatId, stored, payload.note);
      sessions.cancel(chatId);
      sessions.clearNote(chatId);
      const schedule = scheduleFor(chatId);
      return {
        actions: [
          send(chatId, appResultSaved(instrument, result)),
          send(chatId, resultMessage(instrument, result, previous, schedule, config.crisisContact)),
        ],
        payload,
      };
    }

    if (payload.type === "reminders") {
      store.updateUser(chatId, payload.settings);
      return { actions: [send(chatId, reminderLine(chatId))], payload };
    }

    // Deletion is confirmed in the chat rather than performed on a tap inside
    // the app, so an accidental press cannot wipe the history.
    return {
      actions: [send(chatId, "Видалити всі збережені результати та налаштування? Дію не можна скасувати.", {
        reply_markup: {
          inline_keyboard: [[
            { text: "Так, видалити", callback_data: "del|yes" },
            { text: "Скасувати", callback_data: "del|no" },
          ]],
        },
      })],
      payload,
    };
  }

  function handleInvoice(chatId) {
    startTrialFor(chatId);
    if (access(chatId).kind === "pro") return [send(chatId, alreadyPro())];
    return [{ method: "sendInvoice", payload: invoiceFor(chatId, config.price) }];
  }

  // Telegram cancels the payment if this is not answered within ten seconds,
  // so it does no work beyond checking that the invoice is ours.
  function handlePreCheckout(query) {
    const chatId = query && query.from ? query.from.id : null;
    const verdict = checkPreCheckout(query, chatId);
    if (verdict.ok) {
      return [{ method: "answerPreCheckoutQuery", payload: { pre_checkout_query_id: query.id, ok: true } }];
    }
    return [{
      method: "answerPreCheckoutQuery",
      payload: {
        pre_checkout_query_id: query && query.id,
        ok: false,
        error_message: "Не вдалося підтвердити платіж. Спробуйте ще раз через /buy.",
      },
    }];
  }

  function handleSuccessfulPayment(chatId, payment) {
    const record = applyPayment(store, chatId, payment, now());
    if (!record) return [send(chatId, "Платіж отримано, але я не зміг його прочитати. Напишіть у /paysupport.")];
    const state = access(chatId);
    return [send(chatId, purchaseThanks(config.price), {
      reply_markup: config.webappUrl ? appKeyboard(appUrl(state)) : startKeyboard(true),
    })];
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
    if (message.successful_payment) return handleSuccessfulPayment(chatId, message.successful_payment);
    if (message.web_app_data) return handleWebAppData(chatId, message.web_app_data.data).actions;
    if (parsed) return handleCommand(chatId, parsed, message);
    // An open question is waiting: this message is the answer to it. Checked
    // before the digit shortcut, which needs an active questionnaire anyway.
    // Whitespace is ignored rather than answered with a hint, which would read
    // as a refusal while the question is still on screen.
    if (sessions.pendingNote(chatId, now())) {
      return text.trim() ? acceptNote(chatId, text) : [];
    }
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
        const note = outcome.reason === "stale" ? "На це питання вже відповіли." : undefined;
        return [ack(query.id, note)].concat(outcome.actions);
      }
      const chosen = outcome.option ? escapeHtml(outcome.option.label) : "";
      const replay = instrument && message.message_id
        ? [editText(chatId, message.message_id,
          questionText(instrument, askedIndex, active.total) + "\n\nВідповідь: <b>" + chosen + "</b>")]
        : [];
      return [ack(query.id)].concat(replay, outcome.actions);
    }

    const parts = data.split("|");
    if (parts[0] === "s") {
      const instrument = getInstrument(parts[1]);
      if (!instrument) return [ack(query.id, "Невідомий опитувальник")];
      if (sessions.get(chatId, now())) sessions.cancel(chatId);
      return [ack(query.id)].concat(startInstrument(chatId, instrument));
    }
    if (parts[0] === "h") {
      const state = access(chatId);
      if (!state.active) return [ack(query.id)].concat(locked(chatId, state));
      return [ack(query.id), send(chatId, historyMessage(store, chatId, scheduleFor(chatId)))];
    }
    if (parts[0] === "r") {
      const state = access(chatId);
      if (!state.active) return [ack(query.id)].concat(locked(chatId, state));
      if (parts[1] === "off") return [ack(query.id)].concat(handleRemind(chatId, "off"));
      if (parts[1] === "on") return [ack(query.id)].concat(handleRemind(chatId, "on"));
      return [ack(query.id), send(chatId, reminderLine(chatId))];
    }
    if (parts[0] === "pay") {
      return [ack(query.id)].concat(handleInvoice(chatId));
    }
    if (parts[0] === "n") {
      const pending = sessions.pendingNote(chatId, now());
      if (!pending || pending.id !== parts[1]) return [ack(query.id)];
      sessions.clearNote(chatId);
      return [ack(query.id), send(chatId, noteSkipped(), { reply_markup: startKeyboard(access(chatId).active) })];
    }
    if (parts[0] === "del") {
      if (parts[1] === "yes") {
        sessions.cancel(chatId);
        sessions.clearNote(chatId);
        store.forget(chatId);
        return [ack(query.id, "Видалено"), send(chatId, "Усі дані видалено. /start починає заново.")];
      }
      return [ack(query.id), send(chatId, "Видалення скасовано.")];
    }
    return [ack(query.id)];
  }

  function handleUpdate(update) {
    if (!update || typeof update !== "object") return [];
    if (update.message) return handleMessage(update.message);
    if (update.callback_query) return handleCallback(update.callback_query);
    if (update.pre_checkout_query) return handlePreCheckout(update.pre_checkout_query);
    return [];
  }

  function reminderActions(chatId, text) {
    return [send(chatId, text, { reply_markup: startKeyboard(access(chatId).active) })];
  }

  return {
    handleUpdate, handleMessage, handleCallback, handleWebAppData, handlePreCheckout,
    reminderActions, access, instruments: INSTRUMENT_LIST,
  };
}
