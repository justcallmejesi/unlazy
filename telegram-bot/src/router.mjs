// Update routing. User-facing text is Ukrainian. Zero dependencies. Node 16+.
//
// `handleUpdate` is synchronous and performs no input or output: it reads and
// mutates the in-memory store and returns the Bot API calls to make. That keeps
// every conversational branch testable without a network or a live bot.

import { clipText, escapeHtml } from "./telegram.mjs";
import { INSTRUMENT_LIST, buildResult, getInstrument } from "./instruments.mjs";
import { ALREADY_PRO, applyPayment, checkPreCheckout, ensureTrial, entitlement, invoiceFor } from "./billing.mjs";
import {
  DAY_MS, formatLocalDateTime, formatTimeOfDay, localDateKey, nextDueAfter, offsetAt, parseTimeOfDay,
  parseUtcOffset, resolveSchedule,
} from "./reminders.mjs";
import {
  aboutText, answerKeyboard, appIntro, appKeyboard, appRejected, appResultSaved, EXPORT_INLINE_LIMIT,
  exportCaption, exportJson, exportMessage,
  greeting, helpText, historyMessages, lastMessages, noteKeyboard, noteQuestion, noteSaved,
  noteSkipped, questionText, reminderStatus, resultMessage, startKeyboard, unknownInput,
  alreadyPro, buyKeyboard, contactUnavailable, duplicatePurchase, helpKeyboard, helpOffer, helpRequestText,
  paySupport, paySupportDraft, paySupportKeyboard,
  paywall, purchaseThanks, trialNotice, weekdayWords,
  bookingDraft, bookingExpired, bookingFormatKeyboard, bookingIntro, bookingReady, bookingRequestKeyboard,
  bookingRequestQuestion, bookingScoresKeyboard, bookingScoresQuestion, bookingTimeKeyboard,
  bookingTimeQuestion, latestScoreLines, moodDone, moodKeyboard, moodQuestion, moodSaved, moodTagKeyboard,
  practiceMessage, practicesMenu, practicesMenuKeyboard, practicesMessage, reportCaption, reportEmpty,
  reportIntro, reportKeyboard, resultKeyboard, sosHint, sosKeyboard, sosMessage,
} from "./texts.mjs";
import {
  BOOKING_FORMATS, BOOKING_TIMES, MAX_BOOKING_REQUEST, MOOD_LOW, MOOD_MAX, MOOD_MIN, bookingOption,
  getPractice, isSosText, practicesFor,
} from "./selfhelp.mjs";
import { buildReport } from "./report.mjs";
import {
  INVITE_PREFIX, MAX_APPLICATION_FIELD, TERMS_VERSION, activeShare, applySubscriptionPayment,
  checkSubscriptionPreCheckout, clientsOf, findSpecialistByCode, grantShare, isSubscriptionPayload,
  newInviteCode, psyState, revokeShare, setShareNotes, subscriptionInvoice,
} from "./psy.mjs";
import {
  adminApplication, adminDecided, adminDecisionKeyboard, adminNoPending, clientDisconnectedByPsy,
  consentAlready, consentDeclined, consentDone, consentForm, consentInvalid, consentKeyboard,
  consentNotesKeyboard, consentNotesQuestion, consentOwnLink, inviteLink, notAdmin, notesChanged,
  privacyKeyboard, privacyMessage, psyAborted, psyActivated, psyAlert, psyApplied, psyApplyKeyboard,
  psyApproved, psyAskCredentials, psyAskName, psyCanceled, psyClientDeleted, psyClientJoined,
  psyClientKeyboard, psyClientNotes, psyClientRevoked, psyClientsKeyboard, psyClientsList, psyDashboard,
  psyDashboardKeyboard, psyDisconnected, psyGone, psyInactive, psyIntro, psyInvoiceKeyboard,
  psyInvoiceMessage, psyNeedsAccess, psyNewInvite, psyPending, psyRejected, psyRenewed, psyResumed,
  psySubscribeKeyboard, psyTerms, psyTermsKeyboard, revokeKeyboard, revoked,
} from "./psytexts.mjs";
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

// A text that was packed into several messages. The keyboard, if any, goes
// under the last one, where the reader ends up.
function sendAll(chatId, texts, extra = {}) {
  return texts.map((text, index) => send(chatId, text, index === texts.length - 1 ? extra : {}));
}

// /delete and the app's delete button both land here: nothing is erased until
// the person confirms in the chat.
function deleteQuestion(chatId) {
  return send(chatId, "Видалити всі збережені результати та налаштування? Дію не можна скасувати.", {
    reply_markup: {
      inline_keyboard: [[
        { text: "Так, видалити", callback_data: "del|yes" },
        { text: "Скасувати", callback_data: "del|no" },
      ]],
    },
  });
}

function ack(callbackQueryId, text) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  return { method: "answerCallbackQuery", payload };
}

function editText(chatId, messageId, text, keyboard) {
  return {
    method: "editMessageText",
    payload: Object.assign({
      chat_id: chatId, message_id: messageId, text, reply_markup: keyboard || { inline_keyboard: [] },
    }, HTML),
  };
}

function editKeyboard(chatId, messageId, keyboard) {
  return { method: "editMessageReplyMarkup", payload: { chat_id: chatId, message_id: messageId, reply_markup: keyboard } };
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
  // The window has no configuration of its own, so what it may show travels
  // in the launch URL: whether full access is on (a hint only, the bot checks
  // again), and the public contact for the "Мені зараз погано" screen.
  function appUrl(state) {
    if (!config.webappUrl) return null;
    const separator = config.webappUrl.indexOf("?") === -1 ? "?" : "&";
    let url = config.webappUrl + separator + "pro=" + (state.active ? "1" : "0");
    const contact = config.contact;
    if (contact && contact.username) {
      url += "&c=" + encodeURIComponent(contact.username);
      if (contact.name) url += "&cn=" + encodeURIComponent(contact.name);
    }
    return url;
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

  // Offered when a score crosses its cutoff or the risk item is marked. Free
  // for everyone: this is a route to help, not a feature.
  function helpActions(chatId) {
    const contact = config.contact;
    if (!contact || !contact.username) return [];
    const requestText = helpRequestText(store, chatId, scheduleFor(chatId));
    return [send(chatId, helpOffer(contact, requestText), {
      reply_markup: helpKeyboard(contact, requestText, { booking: true }),
    })];
  }

  // Free for everyone, and answered before anything else a message could mean.
  function sosActions(chatId) {
    sessions.clearNote(chatId);
    sessions.clearBooking(chatId);
    const keyboard = sosKeyboard(config.contact);
    return [send(chatId, sosMessage(config.crisisContact, config.contact), keyboard ? { reply_markup: keyboard } : {})];
  }

  function practicesActions(chatId, key) {
    return [send(chatId, practicesMessage(practicesFor(key)))];
  }

  function moodAsk(chatId) {
    startTrialFor(chatId);
    const state = access(chatId);
    if (!state.active) return locked(chatId, state);
    return [send(chatId, moodQuestion(), { reply_markup: moodKeyboard() })];
  }

  function weekAverage(chatId) {
    const since = localDateKey(scheduleFor(chatId), now() - 6 * DAY_MS);
    const recent = store.moods(chatId).filter((entry) => entry.date >= since);
    return recent.length ? recent.reduce((sum, entry) => sum + entry.rating, 0) / recent.length : null;
  }

  function saveMood(chatId, rating, tags) {
    return store.setMood(chatId, {
      date: localDateKey(scheduleFor(chatId), now()),
      rating,
      tags,
      at: new Date(now()).toISOString(),
    });
  }

  function reportAsk(chatId) {
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    if (!user || (!user.results.length && !user.moods.length)) return [send(chatId, reportEmpty())];
    return [send(chatId, reportIntro(), { reply_markup: reportKeyboard() })];
  }

  function reportActions(chatId, includeNotes) {
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    const html = user ? buildReport(user, { schedule: scheduleFor(chatId), includeNotes, nowMs: now() }) : null;
    if (!html) return [send(chatId, reportEmpty())];
    const date = localDateKey(scheduleFor(chatId), now());
    return [{
      method: "sendDocument",
      payload: {
        chat_id: chatId,
        caption: reportCaption(),
        document: { filename: "report-" + date + ".html", contentType: "text/html; charset=utf-8", content: html },
      },
    }];
  }

  function bookingStart(chatId) {
    const contact = config.contact;
    if (!contact || !contact.username) return [send(chatId, contactUnavailable())];
    sessions.clearAll(chatId);
    sessions.startBooking(chatId, now());
    return [send(chatId, bookingIntro(), { reply_markup: bookingFormatKeyboard() })];
  }

  function bookingFinish(chatId, booking, includeScores) {
    sessions.clearBooking(chatId);
    const contact = config.contact;
    if (!contact || !contact.username) return [send(chatId, contactUnavailable())];
    const draft = bookingDraft(booking, includeScores ? latestScoreLines(store, chatId, scheduleFor(chatId)) : []);
    return [send(chatId, bookingReady(contact, draft), {
      reply_markup: helpKeyboard(contact, draft, { verb: "Надіслати заявку" }),
    })];
  }

  // After the request, ask about scores only when there are some to add.
  function bookingAfterRequest(chatId, booking) {
    if (!store.lastResult(chatId, null)) return bookingFinish(chatId, booking, false);
    sessions.updateBooking(chatId, { step: "scores" }, now());
    return [send(chatId, bookingScoresQuestion(), { reply_markup: bookingScoresKeyboard() })];
  }

  // ---------------------------------------------------------- specialist mode

  // The first chat whose username matches the configured owner is bound for
  // good. After that only the chat id counts, never the username.
  function noteAdmin(chatId, from) {
    if (config.admin && config.admin.chatId) return;
    if (store.meta.adminChatId !== null) return;
    const wanted = config.admin && config.admin.username ? config.admin.username.toLowerCase() : "";
    const username = from && typeof from.username === "string" ? from.username.toLowerCase() : "";
    if (wanted && username === wanted && Number(chatId) === Number(from.id)) store.setMeta({ adminChatId: Number(chatId) });
  }

  function isAdmin(chatId) {
    const pinned = config.admin && config.admin.chatId ? config.admin.chatId : store.meta.adminChatId;
    return pinned !== null && pinned !== undefined && Number(chatId) === Number(pinned);
  }

  function dateFor(chatId, ms) {
    const schedule = scheduleFor(chatId);
    return formatLocalDateTime(ms, offsetAt(schedule, ms)).split(" ")[0];
  }

  function stateOf(chatId) {
    return psyState(store.hasUser(chatId) ? store.user(chatId) : null, now(), isAdmin(chatId));
  }

  function psyName(psyChatId) {
    const user = store.hasUser(psyChatId) ? store.user(psyChatId) : null;
    return user && user.psy && user.psy.name ? user.psy.name : "фахівець";
  }

  function ensureInvite(chatId) {
    const user = store.user(chatId);
    if (user.psy && user.psy.inviteCode) return user.psy.inviteCode;
    const code = newInviteCode();
    store.updateUser(chatId, { psy: Object.assign({}, user.psy || { status: "approved" }, { inviteCode: code }) });
    return code;
  }

  function subscribeActions(chatId) {
    return [{
      method: "createInvoiceLink",
      payload: subscriptionInvoice(chatId, config.psy),
      then: (link) => (typeof link === "string" && link
        ? [send(chatId, psyInvoiceMessage(), { reply_markup: psyInvoiceKeyboard(link, config.psy) })]
        : []),
    }];
  }

  // What /psy shows depends on where the specialist stands.
  function psyHome(chatId) {
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    const state = stateOf(chatId);
    if (state.active) {
      if (!user || !user.psy) {
        // The owner without a profile yet: the name clients will see is needed first.
        return [send(chatId, psyIntro(config.psy), { reply_markup: psyApplyKeyboard() })];
      }
      const link = inviteLink(config.botUsername, ensureInvite(chatId));
      const until = state.expiresAt ? dateFor(chatId, state.expiresAt) : "";
      return [send(chatId, psyDashboard(state, link, clientsOf(store, chatId).length, until),
        { reply_markup: psyDashboardKeyboard(state) })];
    }
    if (state.kind === "none") return [send(chatId, psyIntro(config.psy), { reply_markup: psyApplyKeyboard() })];
    if (state.kind === "pending") return [send(chatId, psyPending())];
    if (state.kind === "rejected") return [send(chatId, psyRejected())];
    const expiredOn = state.expiresAt ? dateFor(chatId, state.expiresAt) : "";
    return [send(chatId, psyInactive(state, config.psy, expiredOn), { reply_markup: psySubscribeKeyboard(config.psy) })];
  }

  function requireActive(chatId) {
    return stateOf(chatId).active && store.hasUser(chatId) && store.user(chatId).psy ? null : [send(chatId, psyNeedsAccess())];
  }

  function applicationText(chatId, application, text) {
    const value = text.trim().replace(/\s+/g, " ").slice(0, MAX_APPLICATION_FIELD);
    if (!value) return [];
    if (application.step === "name") {
      sessions.updateApplication(chatId, { name: value.slice(0, 120), step: "credentials" }, now());
      return [send(chatId, psyAskCredentials())];
    }
    if (application.step === "credentials") {
      sessions.updateApplication(chatId, { credentials: value, step: "terms" }, now());
      return [send(chatId, psyTerms(), { reply_markup: psyTermsKeyboard() })];
    }
    return [];
  }

  // The application is stored and sent to the owner. The owner's own is
  // approved on the spot.
  function submitApplication(chatId, application, from) {
    sessions.clearApplication(chatId);
    const user = store.user(chatId);
    const admin = isAdmin(chatId);
    const profile = Object.assign({}, user.psy || {}, {
      status: admin ? "approved" : "pending",
      name: application.name,
      credentials: application.credentials,
      username: from && from.username ? String(from.username) : "",
      appliedAt: new Date(now()).toISOString(),
      decidedAt: admin ? new Date(now()).toISOString() : null,
      termsVersion: TERMS_VERSION,
    });
    store.updateUser(chatId, { psy: profile });
    if (admin) return psyHome(chatId);
    const actions = [send(chatId, psyApplied())];
    const adminChat = config.admin && config.admin.chatId ? config.admin.chatId : store.meta.adminChatId;
    if (adminChat !== null && adminChat !== undefined) {
      actions.push(send(adminChat, adminApplication(store.user(chatId)), { reply_markup: adminDecisionKeyboard(chatId) }));
    }
    return actions;
  }

  function adminList(chatId) {
    if (!isAdmin(chatId)) return [send(chatId, notAdmin())];
    const users = store.allUsers();
    const pending = users.filter((user) => user.psy && user.psy.status === "pending");
    const approved = users.filter((user) => user.psy && user.psy.status === "approved").length;
    if (!pending.length) return [send(chatId, adminNoPending(approved))];
    return pending.map((user) => send(chatId, adminApplication(user), { reply_markup: adminDecisionKeyboard(user.chatId) }));
  }

  function decide(chatId, targetId, approve) {
    if (!isAdmin(chatId)) return [send(chatId, notAdmin())];
    if (!store.hasUser(targetId) || !store.user(targetId).psy) return [];
    const user = store.user(targetId);
    store.updateUser(targetId, { psy: Object.assign({}, user.psy, {
      status: approve ? "approved" : "rejected",
      decidedAt: new Date(now()).toISOString(),
    }) });
    const notice = approve
      ? send(targetId, psyApproved(config.psy), { reply_markup: psySubscribeKeyboard(config.psy) })
      : send(targetId, psyRejected());
    return [send(chatId, adminDecided(user.psy.name, approve)), notice];
  }

  function scaleLine(clientChatId, instrument) {
    const entries = store.history(clientChatId, instrument.id, 2);
    if (!entries.length) return null;
    const last = entries[0];
    const delta = entries[1] ? last.score - entries[1].score : null;
    const change = delta === null || delta === 0 ? "" : " (" + (delta > 0 ? "+" : "") + delta + ")";
    return instrument.title + " " + last.score + "/" + instrument.maxScore + change;
  }

  function flagged(clientChatId) {
    const since = now() - 30 * DAY_MS;
    return store.history(clientChatId, null, 20).some((entry) =>
      Date.parse(entry.completedAt) >= since && (entry.risk || entry.aboveCutoff));
  }

  function clientsActions(chatId) {
    const denied = requireActive(chatId);
    if (denied) return denied;
    const entries = clientsOf(store, chatId);
    const rows = entries.map((entry) => {
      const parts = INSTRUMENT_LIST.map((instrument) => scaleLine(entry.user.chatId, instrument)).filter(Boolean);
      const mood = weekAverage(entry.user.chatId);
      if (mood !== null) parts.push("настрій " + mood.toFixed(1).replace(".", ","));
      return (flagged(entry.user.chatId) ? "⚠️ " : "") + (entry.share.clientName || "Клієнт") + ", з " +
        dateFor(chatId, Date.parse(entry.share.grantedAt)) + (parts.length ? ": " + parts.join(", ") : ": ще немає результатів");
    });
    const buttons = entries.map((entry) => ({ chatId: entry.user.chatId, label: entry.share.clientName || "Клієнт" }));
    return sendAll(chatId, psyClientsList(rows), entries.length ? { reply_markup: psyClientsKeyboard(buttons) } : {});
  }

  function clientCard(chatId, clientChatId) {
    const denied = requireActive(chatId);
    if (denied) return denied;
    const client = store.hasUser(clientChatId) ? store.user(clientChatId) : null;
    const share = activeShare(client, chatId);
    if (!share) return [send(chatId, "Цей клієнт не надав згоди або відкликав її.")];
    const lines = ["<b>" + escapeHtml(share.clientName || "Клієнт") + "</b>",
      "Згода з " + dateFor(chatId, Date.parse(share.grantedAt)) + ", нотатки: " + (share.notes ? "дозволено" : "приховані"), ""];
    INSTRUMENT_LIST.forEach((instrument) => {
      const entries = store.history(clientChatId, instrument.id, 2);
      if (!entries.length) return;
      const last = entries[0];
      const previous = entries[1] ? ", попередній " + entries[1].score : "";
      lines.push("<b>" + escapeHtml(instrument.title) + "</b>: " + last.score + " з " + instrument.maxScore + ", " +
        escapeHtml(last.severity) + " (" + dateFor(chatId, Date.parse(last.completedAt)) + previous + ")");
    });
    const risky = store.history(clientChatId, "phq9", 10).filter((entry) => entry.risk);
    if (risky.length) {
      lines.push("⚠️ PHQ-9, питання 9 позначено: " +
        risky.slice(0, 3).map((entry) => dateFor(chatId, Date.parse(entry.completedAt))).join(", "));
    }
    const mood = weekAverage(clientChatId);
    if (mood !== null) lines.push("Настрій: середнє за 7 днів " + mood.toFixed(1).replace(".", ","));
    if (lines.length === 3) lines.push("Ще немає результатів.");
    if (share.notes) {
      const notes = store.history(clientChatId, null, 10).filter((entry) => entry.note).slice(0, 3);
      if (notes.length) {
        lines.push("", "<b>Нотатки</b>");
        notes.forEach((entry) => lines.push(dateFor(chatId, Date.parse(entry.completedAt)) + ": <i>" +
          escapeHtml(entry.note.length > 300 ? entry.note.slice(0, 300) + "..." : entry.note) + "</i>"));
      }
    }
    return [send(chatId, lines.join("\n"), { reply_markup: psyClientKeyboard(clientChatId) })];
  }

  function clientReport(chatId, clientChatId) {
    const denied = requireActive(chatId);
    if (denied) return denied;
    const client = store.hasUser(clientChatId) ? store.user(clientChatId) : null;
    const share = activeShare(client, chatId);
    if (!share) return [send(chatId, "Цей клієнт не надав згоди або відкликав її.")];
    const html = buildReport(client, { schedule: scheduleFor(chatId), includeNotes: share.notes, nowMs: now() });
    if (!html) return [send(chatId, "У клієнта ще немає даних для звіту.")];
    return [{
      method: "sendDocument",
      payload: {
        chat_id: chatId,
        caption: "Звіт клієнта: " + (share.clientName || "без імені"),
        document: {
          filename: "client-report-" + localDateKey(scheduleFor(chatId), now()) + ".html",
          contentType: "text/html; charset=utf-8",
          content: html,
        },
      },
    }];
  }

  // Alerts only while the specialist's cabinet is active; the client always
  // has the crisis block regardless.
  function alertActions(clientChatId, instrument, result) {
    if (!result.aboveCutoff && !result.risk) return [];
    const client = store.hasUser(clientChatId) ? store.user(clientChatId) : null;
    if (!client) return [];
    return client.shares.filter((share) => !share.revokedAt && stateOf(share.psy).active).map((share) => {
      const lines = [instrument.title + ": " + result.score + " з " + instrument.maxScore + ", " + result.severity + "."];
      // The bot's own scales say what they are not on every result, and a
      // specialist reading a threshold alert needs that most.
      if (instrument.caveat) lines.push(instrument.caveat);
      if (result.risk) lines.push("Позначено питання 9 PHQ-9: думки про смерть або про те, щоб завдати собі шкоди.");
      return send(share.psy, psyAlert(share.clientName, lines), {
        reply_markup: { inline_keyboard: [[{ text: "Картка клієнта", callback_data: "cl|" + clientChatId }]] },
      });
    });
  }

  function consentStart(chatId, code) {
    const psyUser = findSpecialistByCode(store, code);
    const approved = psyUser && (psyUser.psy.status === "approved" || isAdmin(psyUser.chatId));
    if (!approved) return [send(chatId, consentInvalid())];
    if (psyUser.chatId === Number(chatId)) return [send(chatId, consentOwnLink())];
    if (activeShare(store.hasUser(chatId) ? store.user(chatId) : null, psyUser.chatId)) {
      return [send(chatId, consentAlready(psyUser.psy.name))];
    }
    return [send(chatId, consentForm(psyUser.psy.name), { reply_markup: consentKeyboard(code) })];
  }

  function privacyActions(chatId) {
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    const shares = user ? user.shares.filter((share) => !share.revokedAt) : [];
    const rows = shares.map((share) => psyName(share.psy) + ": з " + dateFor(chatId, Date.parse(share.grantedAt)) +
      ", нотатки " + (share.notes ? "видно" : "приховані"));
    const keyboard = privacyKeyboard(shares.map((share) => ({ psy: share.psy, name: psyName(share.psy), notes: share.notes })));
    return [send(chatId, privacyMessage(rows), keyboard ? { reply_markup: keyboard } : {})];
  }

  // Before /delete wipes a person: tell the specialists who saw their data,
  // and if the person is a specialist, close every client's consent to them.
  function forgetActions(chatId) {
    const actions = [];
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    if (!user) return actions;
    user.shares.filter((share) => !share.revokedAt).forEach((share) => {
      actions.push(send(share.psy, psyClientDeleted(share.clientName)));
    });
    if (user.psy) {
      clientsOf(store, chatId).forEach((entry) => {
        revokeShare(store, entry.user.chatId, chatId, "psy", now());
        actions.push(send(entry.user.chatId, psyGone(user.psy.name || "фахівець")));
      });
    }
    return actions;
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

  // Starting a questionnaire always replaces whatever was in progress, from a
  // command and from a start button alike, including a weekly note that would
  // otherwise take a typed answer as its text.
  function startInstrument(chatId, instrument) {
    sessions.clearAll(chatId);
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
    const needsHelp = result.aboveCutoff || result.risk;
    return [
      send(chatId, resultMessage(instrument, result, previous, schedule, config.crisisContact), {
        reply_markup: resultKeyboard(instrument),
      }),
    ].concat(needsHelp ? helpActions(chatId) : [], [
      send(chatId, noteQuestion(), { reply_markup: noteKeyboard(pending.id) }),
    ], alertActions(chatId, instrument, result));
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
      return startInstrument(chatId, INSTRUMENT_COMMANDS[command]);
    }
    switch (command) {
      case "start": {
        if (args.indexOf(INVITE_PREFIX) === 0) {
          if (!store.user(chatId).firstSeenAt) store.updateUser(chatId, { firstSeenAt: new Date(now()).toISOString() });
          startTrialFor(chatId);
          return consentStart(chatId, args.slice(INVITE_PREFIX.length));
        }
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
        // start buttons stay the entry point, and a second message carries the
        // reply keyboard with "Мені зараз погано".
        return config.webappUrl
          ? [hello, send(chatId, appIntro())]
          : [hello, send(chatId, sosHint(), { reply_markup: appKeyboard(null) })];
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
      case "paysupport": {
        const owner = config.admin && config.admin.username ? config.admin.username : null;
        if (!owner) return [send(chatId, paySupport(config.price, null))];
        const user = store.hasUser(chatId) ? store.user(chatId) : null;
        const charges = [];
        if (user && user.pro) charges.push("повний доступ " + user.pro.chargeId);
        if (user && user.psy && user.psy.subscription) charges.push("кабінет фахівця " + user.psy.subscription.lastChargeId);
        return [send(chatId, paySupport(config.price, owner), {
          reply_markup: paySupportKeyboard(owner, paySupportDraft(config.botUsername, chatId, charges)),
        })];
      }
      case "contact": {
        const offer = helpActions(chatId);
        return offer.length ? offer : [send(chatId, contactUnavailable())];
      }
      case "mood":
        return moodAsk(chatId);
      case "selfhelp":
        return [send(chatId, practicesMenu(), { reply_markup: practicesMenuKeyboard() })];
      case "sos":
        return sosActions(chatId);
      case "report":
        return reportAsk(chatId);
      case "book":
        return bookingStart(chatId);
      case "psy":
        return psyHome(chatId);
      case "invite": {
        const denied = requireActive(chatId);
        if (denied) return denied;
        if (/^(new|нове)$/i.test(args)) {
          const user = store.user(chatId);
          store.updateUser(chatId, { psy: Object.assign({}, user.psy, { inviteCode: newInviteCode() }) });
          return [send(chatId, psyNewInvite(inviteLink(config.botUsername, user.psy.inviteCode)))];
        }
        return psyHome(chatId);
      }
      case "clients":
        return clientsActions(chatId);
      case "privacy":
        return privacyActions(chatId);
      case "admin":
        return adminList(chatId);
      case "cancel": {
        const open = sessions.clearAll(chatId);
        if (open.session) return [send(chatId, "Опитувальник перервано. Відповіді не збережені.")];
        if (open.booking) return [send(chatId, "Запис перервано. Почати знову: /book")];
        if (open.application) return [send(chatId, psyAborted())];
        if (open.note) return [send(chatId, noteSkipped(), { reply_markup: startKeyboard(access(chatId).active) })];
        return [send(chatId, "Немає чого перервати.")];
      }
      case "results": {
        const state = access(chatId);
        if (!state.active) return locked(chatId, state);
        return sendAll(chatId, historyMessages(store, chatId, scheduleFor(chatId)),
          { reply_markup: startKeyboard(true) });
      }
      case "last": {
        const state = access(chatId);
        if (!state.active) return locked(chatId, state);
        return sendAll(chatId, lastMessages(store, chatId, scheduleFor(chatId)),
          { reply_markup: startKeyboard(true) });
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
        const body = exportJson({
          chatId: user.chatId,
          remindersEnabled: user.remindersEnabled,
          reminderTime: user.reminderTime,
          tzOffsetMinutes: user.tzOffsetMinutes,
          results: user.results,
          moods: user.moods,
          shares: user.shares,
          psy: user.psy,
        });
        if (body.length <= EXPORT_INLINE_LIMIT) return [send(chatId, exportMessage(body))];
        return [{
          method: "sendDocument",
          payload: {
            chat_id: chatId,
            caption: exportCaption(),
            document: {
              filename: "export-" + localDateKey(scheduleFor(chatId), now()) + ".json",
              contentType: "application/json; charset=utf-8",
              content: body,
            },
          },
        }];
      }
      case "delete":
        return [deleteQuestion(chatId)];
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
          send(chatId, resultMessage(instrument, result, previous, schedule, config.crisisContact), {
            reply_markup: resultKeyboard(instrument),
          }),
        ].concat(result.aboveCutoff || result.risk ? helpActions(chatId) : [], alertActions(chatId, instrument, result)),
        payload,
      };
    }

    if (payload.type === "mood") {
      startTrialFor(chatId);
      const state = access(chatId);
      if (!state.active) return { actions: locked(chatId, state), payload, rejected: "locked" };
      const entry = saveMood(chatId, payload.rating, payload.tags);
      const extra = entry.rating <= MOOD_LOW
        ? { reply_markup: { inline_keyboard: [[{ text: "Що можна зробити зараз", callback_data: "p|mood" }]] } }
        : {};
      return { actions: [send(chatId, moodDone(entry, weekAverage(chatId)), extra)], payload };
    }

    if (payload.type === "report") {
      return { actions: reportActions(chatId, payload.includeNotes), payload };
    }

    if (payload.type === "book") {
      if (!config.contact || !config.contact.username) return { actions: [send(chatId, contactUnavailable())], payload };
      return {
        actions: bookingFinish(chatId, {
          format: payload.format, time: payload.time, request: payload.request,
        }, payload.scores),
        payload,
      };
    }

    if (payload.type === "reminders") {
      // The same gate as /remind and /tz: the reminder and its settings are
      // part of the full access, whichever screen they come from.
      startTrialFor(chatId);
      const state = access(chatId);
      if (!state.active) return { actions: locked(chatId, state), payload, rejected: "locked" };
      store.updateUser(chatId, payload.settings);
      return { actions: [send(chatId, reminderLine(chatId))], payload };
    }

    // Deletion is confirmed in the chat rather than performed on a tap inside
    // the app, so an accidental press cannot wipe the history.
    return {
      actions: [deleteQuestion(chatId)],
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
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    const subscription = Boolean(query && isSubscriptionPayload(query.invoice_payload));
    const verdict = subscription
      ? checkSubscriptionPreCheckout(query, chatId, user)
      : checkPreCheckout(query, chatId, user);
    if (verdict.ok) {
      return [{ method: "answerPreCheckoutQuery", payload: { pre_checkout_query_id: query.id, ok: true } }];
    }
    let errorMessage = "Не вдалося підтвердити платіж. Спробуйте ще раз через " + (subscription ? "/psy." : "/buy.");
    if (verdict.reason === ALREADY_PRO) errorMessage = alreadyPro();
    return [{
      method: "answerPreCheckoutQuery",
      payload: {
        pre_checkout_query_id: query && query.id,
        ok: false,
        error_message: errorMessage,
      },
    }];
  }

  function handleSuccessfulPayment(chatId, payment) {
    if (payment && isSubscriptionPayload(payment.invoice_payload)) {
      const hadOne = Boolean(store.hasUser(chatId) && store.user(chatId).psy && store.user(chatId).psy.subscription);
      const subscription = applySubscriptionPayment(store, chatId, payment, now());
      if (!subscription) return [send(chatId, "Платіж отримано, але я не зміг його прочитати. Напишіть у /paysupport.")];
      const until = dateFor(chatId, subscription.expiresAt);
      const renewal = hadOne && payment.is_first_recurring !== true;
      return [send(chatId, renewal ? psyRenewed(until) : psyActivated(until))];
    }
    const record = applyPayment(store, chatId, payment, now());
    if (!record) return [send(chatId, "Платіж отримано, але я не зміг його прочитати. Напишіть у /paysupport.")];
    if (record.duplicateChargeId) return [send(chatId, duplicatePurchase(record.duplicateChargeId))];
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
    noteAdmin(chatId, message.from);
    if (message.successful_payment) return handleSuccessfulPayment(chatId, message.successful_payment);
    if (message.web_app_data) return handleWebAppData(chatId, message.web_app_data.data).actions;
    if (isSosText(text)) return sosActions(chatId);
    if (parsed) return handleCommand(chatId, parsed, message);
    const application = sessions.application(chatId, now());
    if (application) return applicationText(chatId, application, text);
    const booking = sessions.booking(chatId, now());
    if (booking && booking.step === "request") {
      const request = clipText(text.trim().replace(/\s+/g, " "), MAX_BOOKING_REQUEST);
      if (!request) return [];
      const updated = sessions.updateBooking(chatId, { request }, now());
      return bookingAfterRequest(chatId, updated);
    }
    // An open question is waiting: this message is the answer to it. Checked
    // before the digit shortcut, which needs an active questionnaire anyway.
    // Whitespace is ignored rather than answered with a hint, which would read
    // as a refusal while the question is still on screen.
    if (sessions.pendingNote(chatId, now())) {
      return text.trim() ? acceptNote(chatId, text) : [];
    }
    // A bare 0 to 3 answers the current question, which keeps the bot usable
    // when inline keyboards are unavailable.
    if (/^[0-4]$/.test(text.trim()) && sessions.get(chatId, now())) {
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
    noteAdmin(chatId, query.from);

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
      return [ack(query.id)].concat(startInstrument(chatId, instrument));
    }
    if (parts[0] === "h") {
      const state = access(chatId);
      if (!state.active) return [ack(query.id)].concat(locked(chatId, state));
      return [ack(query.id)].concat(sendAll(chatId, historyMessages(store, chatId, scheduleFor(chatId))));
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
    if (parts[0] === "p") {
      return [ack(query.id)].concat(practicesActions(chatId, parts[1]));
    }
    if (parts[0] === "pp") {
      if (parts[1] === "menu") {
        return [ack(query.id), send(chatId, practicesMenu(), { reply_markup: practicesMenuKeyboard() })];
      }
      const practice = getPractice(parts[1]);
      return practice ? [ack(query.id), send(chatId, practiceMessage(practice))] : [ack(query.id)];
    }
    if (parts[0] === "m") {
      if (parts[1] === "ask") return [ack(query.id)].concat(moodAsk(chatId));
      const rating = Number(parts[1]);
      if (!Number.isInteger(rating) || rating < MOOD_MIN || rating > MOOD_MAX) return [ack(query.id)];
      startTrialFor(chatId);
      const state = access(chatId);
      if (!state.active) return [ack(query.id)].concat(locked(chatId, state));
      const entry = saveMood(chatId, rating);
      const saved = message.message_id
        ? editText(chatId, message.message_id, moodSaved(entry), moodTagKeyboard(entry))
        : send(chatId, moodSaved(entry), { reply_markup: moodTagKeyboard(entry) });
      return [ack(query.id, "Збережено"), saved];
    }
    if (parts[0] === "mt") {
      const entry = store.toggleMoodTag(chatId, parts[1], parts[2]);
      if (!entry || !message.message_id) return [ack(query.id)];
      return [ack(query.id), editKeyboard(chatId, message.message_id, moodTagKeyboard(entry))];
    }
    if (parts[0] === "md") {
      const entry = store.moodOn(chatId, parts[1]);
      if (!entry) return [ack(query.id)];
      const done = moodDone(entry, weekAverage(chatId));
      return [ack(query.id), message.message_id ? editText(chatId, message.message_id, done) : send(chatId, done)];
    }
    if (parts[0] === "rep") {
      if (parts[1] === "ask") return [ack(query.id)].concat(reportAsk(chatId));
      return [ack(query.id, "Готую звіт")].concat(reportActions(chatId, parts[1] === "notes"));
    }
    if (parts[0] === "py") {
      if (parts[1] === "apply") {
        sessions.clearAll(chatId);
        sessions.startApplication(chatId, now());
        return [ack(query.id), send(chatId, psyAskName())];
      }
      if (parts[1] === "terms") {
        const application = sessions.application(chatId, now());
        if (!application || application.step !== "terms") return [ack(query.id), send(chatId, psyAborted())];
        return [ack(query.id)].concat(submitApplication(chatId, application, query.from));
      }
      if (parts[1] === "abort") {
        sessions.clearApplication(chatId);
        return [ack(query.id), send(chatId, psyAborted())];
      }
      if (parts[1] === "sub") {
        const user = store.hasUser(chatId) ? store.user(chatId) : null;
        if (!user || !user.psy || user.psy.status !== "approved") return [ack(query.id)].concat(psyHome(chatId));
        return [ack(query.id)].concat(subscribeActions(chatId));
      }
      if (parts[1] === "clients") return [ack(query.id)].concat(clientsActions(chatId));
      if (parts[1] === "newinv") return [ack(query.id)].concat(handleCommand(chatId, { command: "invite", args: "new" }));
      if (parts[1] === "cancel" || parts[1] === "resume") {
        const user = store.hasUser(chatId) ? store.user(chatId) : null;
        const sub = user && user.psy ? user.psy.subscription : null;
        if (!sub || sub.expiresAt <= now()) return [ack(query.id)].concat(psyHome(chatId));
        const canceled = parts[1] === "cancel";
        const until = dateFor(chatId, sub.expiresAt);
        return [ack(query.id), {
          method: "editUserStarSubscription",
          payload: { user_id: chatId, telegram_payment_charge_id: sub.firstChargeId, is_canceled: canceled },
          then: () => {
            store.updateUser(chatId, { psy: Object.assign({}, user.psy, {
              subscription: Object.assign({}, sub, { canceled }),
            }) });
            return [send(chatId, canceled ? psyCanceled(until) : psyResumed(until))];
          },
        }];
      }
      return [ack(query.id)];
    }
    if (parts[0] === "ap" || parts[0] === "rj") {
      return [ack(query.id)].concat(decide(chatId, Number(parts[1]), parts[0] === "ap"));
    }
    if (parts[0] === "cs") {
      const code = parts[2];
      if (parts[1] !== "yes") return [ack(query.id), send(chatId, consentDeclined())];
      const psyUser = findSpecialistByCode(store, code);
      const approved = psyUser && (psyUser.psy.status === "approved" || isAdmin(psyUser.chatId));
      if (!approved || psyUser.chatId === Number(chatId)) return [ack(query.id), send(chatId, consentInvalid())];
      const from = query.from || {};
      const clientName = [from.first_name, from.last_name].filter(Boolean).join(" ");
      grantShare(store, chatId, psyUser.chatId, clientName, now());
      return [ack(query.id, "Згоду надано"),
        send(chatId, consentNotesQuestion(), { reply_markup: consentNotesKeyboard(psyUser.chatId) }),
        send(psyUser.chatId, psyClientJoined(clientName))];
    }
    if (parts[0] === "cn" || parts[0] === "rn") {
      const psyChatId = Number(parts[1]);
      const notes = parts[2] === "1";
      const share = setShareNotes(store, chatId, psyChatId, notes);
      if (!share) return [ack(query.id)];
      const reply = parts[0] === "cn"
        ? send(chatId, consentDone(psyName(psyChatId), notes), { reply_markup: revokeKeyboard(psyChatId) })
        : send(chatId, notesChanged(psyName(psyChatId), notes));
      const extra = parts[0] === "rn" || notes ? [send(psyChatId, psyClientNotes(share.clientName, notes))] : [];
      // Someone who arrived through an invite has not seen the greeting yet,
      // nor the keyboard that keeps "Мені зараз погано" in reach.
      const welcome = parts[0] === "cn" ? handleCommand(chatId, { command: "start", args: "" }, { from: query.from }) : [];
      return [ack(query.id), reply].concat(extra, welcome);
    }
    if (parts[0] === "rv") {
      const psyChatId = Number(parts[1]);
      const share = revokeShare(store, chatId, psyChatId, "client", now());
      if (!share) return [ack(query.id), send(chatId, "Цю згоду вже відкликано.")];
      return [ack(query.id, "Згоду відкликано"), send(chatId, revoked(psyName(psyChatId))),
        send(psyChatId, psyClientRevoked(share.clientName))];
    }
    if (parts[0] === "cl") return [ack(query.id)].concat(clientCard(chatId, Number(parts[1])));
    if (parts[0] === "clr") return [ack(query.id, "Готую звіт")].concat(clientReport(chatId, Number(parts[1])));
    if (parts[0] === "cld") {
      const clientChatId = Number(parts[1]);
      const share = revokeShare(store, clientChatId, chatId, "psy", now());
      if (!share) return [ack(query.id)];
      return [ack(query.id), send(chatId, psyDisconnected(share.clientName)),
        send(clientChatId, clientDisconnectedByPsy(psyName(chatId)))];
    }
    if (parts[0] === "b") {
      if (parts[1] === "start") return [ack(query.id)].concat(bookingStart(chatId));
      const booking = sessions.booking(chatId, now());
      if (!booking) return [ack(query.id), send(chatId, bookingExpired())];
      if (parts[1] === "f" && booking.step === "format" && bookingOption(BOOKING_FORMATS, parts[2])) {
        sessions.updateBooking(chatId, { format: parts[2], step: "time" }, now());
        const next = bookingTimeQuestion();
        return [ack(query.id), message.message_id
          ? editText(chatId, message.message_id, next, bookingTimeKeyboard())
          : send(chatId, next, { reply_markup: bookingTimeKeyboard() })];
      }
      if (parts[1] === "t" && booking.step === "time" && bookingOption(BOOKING_TIMES, parts[2])) {
        sessions.updateBooking(chatId, { time: parts[2], step: "request" }, now());
        return [ack(query.id), send(chatId, bookingRequestQuestion(), { reply_markup: bookingRequestKeyboard() })];
      }
      if (parts[1] === "r" && booking.step === "request") {
        return [ack(query.id)].concat(bookingAfterRequest(chatId, booking));
      }
      if (parts[1] === "s" && booking.step === "scores") {
        return [ack(query.id)].concat(bookingFinish(chatId, booking, parts[2] === "yes"));
      }
      return [ack(query.id)];
    }
    if (parts[0] === "n") {
      const pending = sessions.pendingNote(chatId, now());
      if (!pending || pending.id !== parts[1]) return [ack(query.id)];
      sessions.clearNote(chatId);
      return [ack(query.id), send(chatId, noteSkipped(), { reply_markup: startKeyboard(access(chatId).active) })];
    }
    if (parts[0] === "del") {
      if (parts[1] === "yes") {
        sessions.clearAll(chatId);
        const notices = forgetActions(chatId);
        store.forget(chatId);
        return [ack(query.id, "Видалено"), send(chatId, "Усі дані видалено. /start починає заново.")].concat(notices);
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
