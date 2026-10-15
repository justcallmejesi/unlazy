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
  aboutText, answerKeyboard, appIntro, appRejected, appResultSaved, EXPORT_INLINE_LIMIT,
  exportCaption, exportJson, exportMessage,
  greeting, helpText, historyMessages, lastMessages, noteKeyboard, noteQuestion, noteSaved,
  noteSkipped, questionText, reminderStatus, resultMessage, startKeyboard, unknownInput,
  accessOffer, alreadyPro, buyKeyboard, contactUnavailable, duplicatePurchase, helpKeyboard, helpOffer,
  helpRequestText, isAccessText, menuKeyboard, menuTarget, menuText,
  paySupport, paySupportDraft, paySupportKeyboard,
  paywall, purchaseThanks, trialNotice, weekdayWords,
  bookingDraft, bookingExpired, bookingFormatKeyboard, bookingIntro, bookingReady, bookingRequestKeyboard,
  bookingRequestQuestion, bookingScoresKeyboard, bookingScoresQuestion, bookingTimeKeyboard,
  bookingTimeQuestion, latestScoreLines, moodDone, moodKeyboard, moodQuestion, moodSaved, moodTagKeyboard,
  practiceMessage, practicesMenu, practicesMenuKeyboard, practicesMessage, reportCaption, reportEmpty,
  reportIntro, reportKeyboard, resultKeyboard, sosKeyboard, sosMessage,
} from "./texts.mjs";
import {
  BOOKING_FORMATS, BOOKING_TIMES, MAX_BOOKING_REQUEST, MOOD_LOW, MOOD_MAX, MOOD_MIN, bookingOption,
  getPractice, isSosText, practicesFor,
} from "./selfhelp.mjs";
import { buildReport } from "./report.mjs";
import { collectStats } from "./stats.mjs";
import {
  INVITE_PREFIX, MAX_APPLICATION_FIELD, TERMS_VERSION, activeShare, applySubscriptionPayment,
  checkSubscriptionPreCheckout, clientsOf, findSpecialistByCode, grantShare, isSubscriptionPayload,
  newInviteCode, psyState, revokeShare, setShareNotes, subscriptionInvoice,
  allowsCrisisSignal, updateShareVersion,
} from "./psy.mjs";
import {
  adminApplication, adminDecided, adminDecisionKeyboard, adminNoPending, adminStats, clientDisconnectedByPsy,
  consentAlready, consentDeclined, consentDone, consentForm, consentInvalid, consentKeyboard,
  consentNotesKeyboard, consentNotesQuestion, consentOwnLink, inviteLink, notAdmin, notesChanged,
  privacyKeyboard, privacyMessage, psyAborted, psyActivated, psyAlert, psyApplied, psyApplyKeyboard,
  psyApproved, psyAskCredentials, psyAskName, psyCanceled, psyClientDeleted, psyClientJoined,
  psyClientKeyboard, psyClientNotes, psyClientRevoked, psyClientsKeyboard, psyClientsList, psyDashboard,
  psyDashboardKeyboard, psyDisconnected, psyGone, psyInactive, psyIntro, psyInvoiceKeyboard,
  psyInvoiceMessage, psyNeedsAccess, psyNewInvite, psyPending, psyRejected, psyRenewed, psyResumed,
  psySubscribeKeyboard, psyTerms, psyTermsKeyboard, revokeKeyboard, revoked,
  homeworkAsk, homeworkDoneForPsy, homeworkDoneKeyboard, homeworkForClient, homeworkList, homeworkListKeyboard,
  homeworkPickClient, homeworkPickKeyboard, homeworkSent,
  consentOutdatedLine, consentUpdated, psyCrisisSignal,
} from "./psytexts.mjs";
import { MAX_HOMEWORK_PER_USER, MAX_HOMEWORK_TEXT } from "./store.mjs";
import { randomBytes } from "node:crypto";
import { parseStartCode, parseWebAppPayload } from "./webapp.mjs";
import { detectCrisis, detectIntent } from "./crisis.mjs";
import {
  BOOKING_DAYS_AHEAD, DIARY_STEPS, MAX_BOOKINGS_PER_USER, MAX_CARE_TEXT, MAX_DIARY_ENTRIES, PLAN_STEPS, PREP_STEPS,
  SESSION_MINUTES, bookingCard, bookingPsyKeyboard, dayLabel, diaryDone, diaryDoneKeyboard, diaryEntryText, diaryIntro,
  diaryIntroKeyboard, diaryScaleKeyboard, freeSlots, insightsText, moodInsights, parseWeeklyTemplate, planIntro,
  planMessage, planSaved, planStartKeyboard, planStepKeyboard, templateText,
} from "./care.mjs";
import {
  DAILY_MOOD_TIME, dailyMoodKeyboard, dailyMoodOffer, dailyMoodOfferKeyboard, dailyMoodQuestion, dailyMoodSet,
  friendlyUnknown, lockedGentle, moodWeekSummary, shortGreeting, startCtaKeyboard, trialEnding,
  trialEndingKeyboard,
} from "./texts.mjs";

// How long a marked PHQ-9 item 9 or a typed crisis phrase keeps every
// unasked-for payment prompt away.
const RISK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Two daily reminders without a word back, and the bot falls silent.
const QUIET_AFTER_UNANSWERED = 2;

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
  function appUrl(state, chatId) {
    if (!config.webappUrl) return null;
    const separator = config.webappUrl.indexOf("?") === -1 ? "?" : "&";
    let url = config.webappUrl + separator + "pro=" + (state.active ? "1" : "0") + "&plan=" + state.kind;
    if (state.kind === "trial") url += "&days=" + state.daysLeft;
    url += "&price=" + Number(config.price.stars);
    const contact = config.contact;
    if (contact && contact.username) {
      url += "&c=" + encodeURIComponent(contact.username);
      if (contact.name) url += "&cn=" + encodeURIComponent(contact.name);
    }
    // The bot's name lets a window opened from the menu button reach the chat
    // through a start link, and the specialist screen shows where the cabinet
    // stands. Hints again: every command checks for itself.
    if (config.botUsername) url += "&b=" + encodeURIComponent(config.botUsername);
    if (chatId !== undefined) url += "&psy=" + stateOf(chatId).kind + "&pp=" + Number(config.psy.stars);
    // The window hides every offer from someone at risk, as the chat does.
    if (chatId !== undefined && atRisk(chatId)) url += "&r=1";
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
    return [sosBlock(chatId)].concat(planActions(chatId));
  }

  // The same help block without closing what the bot was waiting for: a
  // crisis phrase typed as a weekly note still becomes the note.
  function sosBlock(chatId) {
    const keyboard = sosKeyboard(config.contact);
    return send(chatId, sosMessage(config.crisisContact, config.contact), keyboard ? { reply_markup: keyboard } : {});
  }

  // A marked PHQ-9 item 9 or a typed crisis phrase within RISK_WINDOW_MS.
  // Such a person never gets an unasked-for price, pay button or reminder of
  // the trial; /buy and "⭐ Повний доступ" still answer, as their own choice.
  function atRisk(chatId) {
    if (!store.hasUser(chatId)) return false;
    const user = store.user(chatId);
    const since = now() - RISK_WINDOW_MS;
    if (user.crisisAt && Date.parse(user.crisisAt) >= since) return true;
    return user.results.some((entry) => entry.instrument === "phq9" && entry.risk && Date.parse(entry.completedAt) >= since);
  }

  // ---------------------------------------------------------- funnel

  // Counted per day of the bot's own zone, never per person.
  function funnelDay() {
    return localDateKey(resolveSchedule(null, config.reminder), now());
  }

  function countFunnel(step) {
    store.countFunnel(funnelDay(), step);
  }

  // Any message or tap: the person is here, so the daily reminder may speak
  // again, and a first return on the next day is counted once.
  function noteActivity(chatId) {
    if (!store.hasUser(chatId)) return;
    const user = store.user(chatId);
    if (user.dailyMood.unanswered) user.dailyMood = Object.assign({}, user.dailyMood, { unanswered: 0 });
    if (!user.returnedCounted && user.firstSeenAt) {
      const schedule = scheduleFor(chatId);
      const firstDay = localDateKey(schedule, Date.parse(user.firstSeenAt));
      const nextDay = localDateKey(schedule, Date.parse(user.firstSeenAt) + DAY_MS);
      const today = localDateKey(schedule, now());
      if (today === nextDay) {
        countFunnel("returned");
        user.returnedCounted = true;
      } else if (today > nextDay && today !== firstDay) {
        // Too late to count as the next day; stop checking.
        user.returnedCounted = true;
      }
    }
    store.touch();
  }

  // ---------------------------------------------------------- habits

  // Offered once, after the first result, while the reminder would work.
  // Sent by habitActions, never inside a conversation.
  function dailyMoodOfferActions(chatId) {
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    if (!user || user.dailyMood.offered || !access(chatId).active) return [];
    user.dailyMood = Object.assign({}, user.dailyMood, { offered: true });
    store.touch();
    return [send(chatId, dailyMoodOffer(), { reply_markup: dailyMoodOfferKeyboard() })];
  }

  // The third check-in of a week brings a short summary, once a week.
  function moodSummaryActions(chatId) {
    const user = store.user(chatId);
    const since = localDateKey(scheduleFor(chatId), now() - 6 * DAY_MS);
    const week = user.moods.filter((entry) => entry.date >= since);
    if (week.length < 3) return [];
    if (user.moodSummaryAt && Date.parse(user.moodSummaryAt) > now() - 6 * DAY_MS) return [];
    store.updateUser(chatId, { moodSummaryAt: new Date(now()).toISOString() });
    return [send(chatId, moodWeekSummary(week))];
  }

  function localMinutes(schedule, ms) {
    const local = new Date(ms + offsetAt(schedule, ms) * 60000);
    return local.getUTCHours() * 60 + local.getUTCMinutes();
  }

  // Everything the bot says unasked, apart from the weekly reminder: the
  // daily mood question at 20:00 local and the last-trial-day notice. Marks
  // what it sends as sent, so a second call at the same time sends nothing.
  function habitActions() {
    const actions = [];
    const [hour, minute] = DAILY_MOOD_TIME.split(":").map(Number);
    store.allUsers().forEach((user) => {
      const chatId = user.chatId;
      const quiet = user.dailyMood.unanswered >= QUIET_AFTER_UNANSWERED;
      if (quiet) return;
      const schedule = resolveSchedule(user, config.reminder);
      const today = localDateKey(schedule, now());
      const minutes = localMinutes(schedule, now());
      const state = entitlement(user, now());
      if (user.dailyMood.enabled && state.active && user.dailyMood.lastSentDate !== today &&
        minutes >= hour * 60 + minute && !user.moods.some((entry) => entry.date === today)) {
        user.dailyMood = Object.assign({}, user.dailyMood, {
          lastSentDate: today, unanswered: user.dailyMood.unanswered + 1,
        });
        store.touch();
        actions.push(send(chatId, dailyMoodQuestion(), { reply_markup: dailyMoodKeyboard() }));
      }
      // The daily reminder is offered once, some minutes after the first
      // result, so it never cuts into the weekly note that follows a test.
      const firstResult = user.results[0];
      if (!user.dailyMood.offered && firstResult && state.active && now() - Date.parse(firstResult.completedAt) >= 10 * 60000 &&
        minutes >= 10 * 60 && minutes < 21 * 60) {
        actions.push(...dailyMoodOfferActions(chatId));
      }
      // Daytime only, on the day before the trial ends, never to someone at risk.
      if (state.kind === "trial" && !user.trialNoticeAt && user.trialEndsAt - now() <= 2 * DAY_MS &&
        user.trialEndsAt - now() > DAY_MS &&
        minutes >= 10 * 60 && minutes < 21 * 60 && !atRisk(chatId)) {
        store.updateUser(chatId, { trialNoticeAt: new Date(now()).toISOString() });
        countFunnel("paywall");
        actions.push(send(chatId, trialEnding(), { reply_markup: trialEndingKeyboard() }));
      }
    });
    return actions.concat(sessionHabits());
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

  // The owner's numbers, aggregates only.
  function statsActions(chatId) {
    if (!isAdmin(chatId)) return [send(chatId, notAdmin())];
    return [send(chatId, adminStats(collectStats(store.allUsers(), now(), isAdmin, store.meta.funnel, funnelDay())))];
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
    // Only the tasks this specialist gave, never another specialist's.
    const tasks = client.homework.filter((entry) => entry.psy === Number(chatId)).slice(-5);
    if (tasks.length) {
      lines.push("", "<b>Домашні завдання</b>");
      tasks.forEach((entry) => lines.push((entry.doneAt ? "✅ " : "⏳ ") + escapeHtml(entry.text.length > 120
        ? entry.text.slice(0, 120) + "..." : entry.text)));
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

  // ---------------------------------------------------------- care: plan, diary, insights, sessions

  // A step-by-step conversation the bot is in with someone: the safety plan,
  // a diary entry, a session topic, the session prep, a specialist's weekly
  // template. In memory on purpose, like a homework draft: a restart only
  // means starting the step again. Thirty minutes of silence ends it.
  const flows = new Map();
  const FLOW_IDLE_MS = 30 * 60 * 1000;
  const newId = () => randomBytes(6).toString("hex");

  function flowOf(chatId) {
    const flow = flows.get(Number(chatId));
    if (!flow) return null;
    if (now() - flow.at > FLOW_IDLE_MS) {
      flows.delete(Number(chatId));
      return null;
    }
    return flow;
  }

  function setFlow(chatId, flow) {
    flows.set(Number(chatId), Object.assign(flow, { at: now() }));
  }

  // The safety plan follows the help block, never stands in for it.
  function planActions(chatId) {
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    if (!user || !user.safetyPlan) return [];
    return [send(chatId, planMessage(user.safetyPlan, null))];
  }

  function planCommand(chatId) {
    const user = store.user(chatId);
    if (user.safetyPlan) {
      return [send(chatId, planMessage(user.safetyPlan, null), { reply_markup: planStartKeyboard(true) })];
    }
    return [send(chatId, planIntro(), { reply_markup: planStartKeyboard(false) })];
  }

  function planAsk(chatId, step) {
    return send(chatId, PLAN_STEPS[step].ask, { reply_markup: planStepKeyboard() });
  }

  function planStep(chatId, flow, text) {
    const step = PLAN_STEPS[flow.step];
    if (text) flow.data[step.key] = text.trim().slice(0, MAX_CARE_TEXT);
    flow.step += 1;
    if (flow.step < PLAN_STEPS.length) {
      setFlow(chatId, flow);
      return [planAsk(chatId, flow.step)];
    }
    flows.delete(Number(chatId));
    const plan = Object.assign({}, flow.data, { updatedAt: new Date(now()).toISOString() });
    store.updateUser(chatId, { safetyPlan: Object.keys(flow.data).length ? plan : null });
    const saved = store.user(chatId).safetyPlan;
    return saved ? [send(chatId, planSaved()), send(chatId, planMessage(saved, null))] : [send(chatId, "План порожній, тому не збережений. Скласти знову: /plan")];
  }

  function diaryAsk(chatId, step) {
    const definition = DIARY_STEPS[step];
    return send(chatId, definition.ask, definition.scale ? { reply_markup: diaryScaleKeyboard(definition.key) } : {});
  }

  function diaryStep(chatId, flow, value) {
    const step = DIARY_STEPS[flow.step];
    flow.data[step.key] = step.scale ? value : String(value).trim().slice(0, MAX_CARE_TEXT);
    flow.step += 1;
    if (flow.step < DIARY_STEPS.length) {
      setFlow(chatId, flow);
      return [diaryAsk(chatId, flow.step)];
    }
    flows.delete(Number(chatId));
    const entry = Object.assign({ id: newId(), at: new Date(now()).toISOString(), sentTo: [] }, flow.data);
    const user = store.user(chatId);
    store.updateUser(chatId, { diary: user.diary.concat([entry]).slice(-MAX_DIARY_ENTRIES) });
    return [send(chatId, diaryEntryText(entry, dateFor(chatId, now()))),
      send(chatId, diaryDone(entry), { reply_markup: diaryDoneKeyboard(entry, consentedSpecialists(chatId)) })];
  }

  // Specialists who may receive something from this person right now.
  function consentedSpecialists(chatId) {
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    if (!user) return [];
    return user.shares.filter((share) => !share.revokedAt && stateOf(share.psy).active)
      .map((share) => ({ chatId: share.psy, name: psyName(share.psy) }));
  }

  function insightsActions(chatId) {
    startTrialFor(chatId);
    const state = access(chatId);
    if (!state.active) return locked(chatId, state);
    return [send(chatId, insightsText(moodInsights(store.moods(chatId))))];
  }

  // ---- sessions

  function psyOffset(psyChatId) {
    const schedule = scheduleFor(psyChatId);
    return (ms) => offsetAt(schedule, ms);
  }

  function whenFor(psyChatId, at) {
    const local = formatLocalDateTime(at, offsetAt(scheduleFor(psyChatId), at));
    const dateKey = localDateKey(scheduleFor(psyChatId), at);
    return dayLabel(dateKey) + " о " + local.split(" ")[1];
  }

  // Every live booking with a specialist, across their clients.
  function bookingsOf(psyChatId) {
    const found = [];
    store.allUsers().forEach((user) => {
      user.bookings.forEach((booking) => {
        if (booking.psy === Number(psyChatId) && booking.status !== "canceled") found.push({ client: user, booking });
      });
    });
    return found.sort((left, right) => left.booking.at - right.booking.at);
  }

  function slotsFor(psyChatId) {
    const psyUser = store.hasUser(psyChatId) ? store.user(psyChatId) : null;
    if (!psyUser || !psyUser.psy || !psyUser.psy.schedule || !stateOf(psyChatId).active) return [];
    const taken = bookingsOf(psyChatId).map((entry) => entry.booking.at);
    return freeSlots(psyUser.psy.schedule, localDateKey(scheduleFor(psyChatId), now()), now(), psyOffset(psyChatId), taken);
  }

  function bookableSpecialists(chatId) {
    return consentedSpecialists(chatId).filter((specialist) => slotsFor(specialist.chatId).length);
  }

  function upcomingOf(chatId) {
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    return user ? user.bookings.filter((booking) => booking.status !== "canceled" && booking.at > now()) : [];
  }

  function sessionCommand(chatId) {
    const upcoming = upcomingOf(chatId);
    const lines = upcoming.map((booking) => "• " + escapeHtml(psyName(booking.psy)) + ", " + escapeHtml(whenFor(booking.psy, booking.at)) +
      " (" + (booking.status === "confirmed" ? "підтверджено" : "чекає підтвердження") + ")");
    const cancelRows = upcoming.map((booking) => [{ text: "Скасувати: " + whenFor(booking.psy, booking.at), callback_data: "sc|" + booking.id }]);
    const specialists = bookableSpecialists(chatId);
    const head = ["🗓 <b>Запис до фахівця</b>", ""];
    if (lines.length) head.push("<b>Ваші записи</b>", ...lines, "");
    if (!specialists.length) {
      head.push(consentedSpecialists(chatId).length
        ? "У Вашого фахівця зараз немає вільних вікон у розкладі. Можна написати йому напряму: /contact."
        : "Записатися тут можна до фахівця, якому Ви надали згоду за його посиланням. Без цього: /book готує повідомлення психологу.");
      return [send(chatId, head.join("\n"), cancelRows.length ? { reply_markup: { inline_keyboard: cancelRows } } : {})];
    }
    if (specialists.length > 1) {
      head.push("До кого записатися?");
      const rows = specialists.map((specialist) => [{ text: specialist.name, callback_data: "sb|" + specialist.chatId }]);
      return [send(chatId, head.join("\n"), { reply_markup: { inline_keyboard: rows.concat(cancelRows) } })];
    }
    return [send(chatId, head.join("\n") + "Оберіть день:", { reply_markup: { inline_keyboard: dayRows(specialists[0].chatId).concat(cancelRows) } })];
  }

  function dayRows(psyChatId) {
    const days = Array.from(new Set(slotsFor(psyChatId).map((slot) => slot.date)));
    const buttons = days.map((date) => ({ text: dayLabel(date), callback_data: "sd|" + psyChatId + "|" + date.replace(/-/g, "") }));
    const rows = [];
    for (let index = 0; index < buttons.length; index += 3) rows.push(buttons.slice(index, index + 3));
    return rows;
  }

  function timeRows(psyChatId, compactDate) {
    const date = compactDate.slice(0, 4) + "-" + compactDate.slice(4, 6) + "-" + compactDate.slice(6, 8);
    const buttons = slotsFor(psyChatId).filter((slot) => slot.date === date)
      .map((slot) => ({ text: slot.time, callback_data: "st|" + psyChatId + "|" + slot.at }));
    const rows = [];
    for (let index = 0; index < buttons.length; index += 4) rows.push(buttons.slice(index, index + 4));
    return rows;
  }

  function mayBook(chatId, psyChatId) {
    return consentedSpecialists(chatId).some((specialist) => specialist.chatId === Number(psyChatId));
  }

  // The client chose a time: ask what they would like to talk about.
  function chooseTime(chatId, psyChatId, at) {
    if (!mayBook(chatId, psyChatId)) return [send(chatId, "Записатися можна лише до фахівця, якому Ви надали згоду.")];
    if (!slotsFor(psyChatId).some((slot) => slot.at === at)) return [send(chatId, "Цей час уже зайнятий або минув. Оберіть інший: /session")];
    sessions.clearAll(chatId);
    setFlow(chatId, { kind: "topic", psy: Number(psyChatId), atMs: at, data: {} });
    return [send(chatId, "🗓 " + escapeHtml(psyName(psyChatId)) + ", " + escapeHtml(whenFor(psyChatId, at)) + ".\n\n" +
      "Про що хотілося б поговорити? Кілька слів, щоб фахівець міг підготуватися. Це побачить лише " + escapeHtml(psyName(psyChatId)) + ".",
    { reply_markup: { inline_keyboard: [[{ text: "Пропустити", callback_data: "bk|skip" }]] } })];
  }

  function createBooking(chatId, flow, topic) {
    flows.delete(Number(chatId));
    if (!mayBook(chatId, flow.psy) || !slotsFor(flow.psy).some((slot) => slot.at === flow.atMs)) {
      return [send(chatId, "Цей час уже зайнятий. Оберіть інший: /session")];
    }
    const booking = {
      id: newId(), psy: flow.psy, at: flow.atMs, status: "pending", topic: (topic || "").trim().slice(0, MAX_CARE_TEXT),
      createdAt: new Date(now()).toISOString(), canceledBy: null, prep: null, prepAskedAt: null, summarySentAt: null,
    };
    const user = store.user(chatId);
    store.updateUser(chatId, { bookings: user.bookings.concat([booking]).slice(-MAX_BOOKINGS_PER_USER) });
    return [
      send(chatId, "Запит надіслано: " + escapeHtml(psyName(flow.psy)) + ", " + escapeHtml(whenFor(flow.psy, booking.at)) +
        ". Коли фахівець підтвердить, я напишу. За день до зустрічі запропоную коротку підготовку.",
      { reply_markup: { inline_keyboard: [[{ text: "Скасувати запис", callback_data: "sc|" + booking.id }]] } }),
      sessionCardAction(flow.psy, user, booking, "Новий запис"),
    ];
  }

  function sessionCardAction(psyChatId, client, booking, title, prepMissing) {
    const share = activeShare(client, psyChatId);
    const scoreLines = share ? sessionScoreLines(client.chatId, psyChatId) : null;
    return send(psyChatId, bookingCard(booking, {
      title, clientName: share ? share.clientName : "Клієнт", when: whenFor(psyChatId, booking.at), scoreLines, prepMissing,
    }), { reply_markup: bookingPsyKeyboard(client.chatId, booking) });
  }

  function sessionScoreLines(clientChatId, psyChatId) {
    const lines = INSTRUMENT_LIST.map((instrument) => scaleLine(clientChatId, instrument)).filter(Boolean);
    const mood = weekAverage(clientChatId);
    if (mood !== null) lines.push("Настрій за 7 днів: " + mood.toFixed(1).replace(".", ","));
    const tasks = store.user(clientChatId).homework.filter((entry) => entry.psy === Number(psyChatId));
    if (tasks.length) lines.push("Домашні завдання: виконано " + tasks.filter((entry) => entry.doneAt).length + " з " + tasks.length);
    if (flagged(clientChatId)) lines.push("⚠️ За 30 днів був результат вище порогу або позначене питання 9 PHQ-9");
    if (!lines.length) lines.push("Ще немає результатів.");
    return lines;
  }

  function findBooking(clientChatId, id) {
    const client = store.hasUser(clientChatId) ? store.user(clientChatId) : null;
    const booking = client ? client.bookings.find((entry) => entry.id === id) : null;
    return booking ? { client, booking } : null;
  }

  function cancelBooking(found, by) {
    found.booking.status = "canceled";
    found.booking.canceledBy = by;
    store.touch();
    const when = whenFor(found.booking.psy, found.booking.at);
    const share = activeShare(found.client, found.booking.psy);
    const name = share ? share.clientName : "Клієнт";
    return by === "client"
      ? [send(found.client.chatId, "Запис скасовано: " + escapeHtml(when) + "."),
        send(found.booking.psy, "Запис скасовано клієнтом: " + escapeHtml(name || "Клієнт") + ", " + escapeHtml(when) + ".")]
      : [send(found.client.chatId, escapeHtml(psyName(found.booking.psy)) + " скасовує запис на " + escapeHtml(when) +
        ". Обрати інший час: /session"),
      send(found.booking.psy, "Запис скасовано: " + escapeHtml(name || "Клієнт") + ", " + escapeHtml(when) + ".")];
  }

  // Upcoming sessions between a client and a specialist, when the consent
  // between them ends: cancelled, both told once.
  function cancelBetween(clientChatId, psyChatId) {
    const client = store.hasUser(clientChatId) ? store.user(clientChatId) : null;
    if (!client) return [];
    const upcoming = client.bookings.filter((booking) => booking.psy === Number(psyChatId) && booking.status !== "canceled" && booking.at > now());
    if (!upcoming.length) return [];
    upcoming.forEach((booking) => { booking.status = "canceled"; booking.canceledBy = "consent"; });
    store.touch();
    return [send(clientChatId, "Записи до " + escapeHtml(psyName(psyChatId)) + " скасовано, бо згоду закрито."),
      send(psyChatId, "Записи клієнта скасовано: згоду закрито (" + upcoming.length + ").")];
  }

  function sessionsForPsy(chatId) {
    const denied = requireActive(chatId);
    if (denied) return denied;
    const user = store.user(chatId);
    const upcoming = bookingsOf(chatId).filter((entry) => entry.booking.at > now());
    const lines = ["🗓 <b>Записи і розклад</b>", "", "Розклад: " + escapeHtml(templateText(user.psy.schedule)) + "."];
    if (!upcoming.length) lines.push("", "Майбутніх записів немає.");
    else {
      lines.push("", "<b>Майбутні</b>");
      upcoming.forEach((entry) => {
        const share = activeShare(entry.client, chatId);
        lines.push("• " + escapeHtml(whenFor(chatId, entry.booking.at)) + ", " + escapeHtml(share ? share.clientName || "Клієнт" : "Клієнт") +
          (entry.booking.status === "pending" ? ", чекає підтвердження" : ""));
      });
    }
    lines.push("", "Клієнти зі згодою записуються самі: /session у них у чаті. За день до зустрічі бот попросить їх про коротку підготовку, а Вам надішле зведення.");
    const rows = upcoming.slice(0, 20).map((entry) => [{
      text: whenFor(chatId, entry.booking.at) + ": " + ((activeShare(entry.client, chatId) || {}).clientName || "Клієнт"),
      callback_data: "bv|" + entry.client.chatId + "|" + entry.booking.id,
    }]);
    rows.push([{ text: "✏️ Змінити розклад", callback_data: "ss|edit" }]);
    return [send(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: rows } })];
  }

  function scheduleAsk(chatId) {
    const denied = requireActive(chatId);
    if (denied) return denied;
    setFlow(chatId, { kind: "schedule", data: {} });
    return [send(chatId, "Напишіть тижневий розклад одним повідомленням: день і години, дні через крапку з комою.\n\n" +
      "Наприклад: <code>Пн 18:00, 19:00; Ср 10:00, 11:00; Сб 12:00</code>\n\n" +
      "Зустріч триває " + SESSION_MINUTES + " хвилин, клієнти бачать вільні вікна на " + BOOKING_DAYS_AHEAD +
      " днів уперед. Прибрати розклад: напишіть <code>очистити</code>. Передумали: /cancel")];
  }

  function scheduleSave(chatId, text) {
    const user = store.user(chatId);
    if (/^(очистити|очистить|clear)$/i.test(text.trim())) {
      flows.delete(Number(chatId));
      store.updateUser(chatId, { psy: Object.assign({}, user.psy, { schedule: null }) });
      return [send(chatId, "Розклад прибрано. Нові записи неможливі, наявні залишаються.")];
    }
    const slots = parseWeeklyTemplate(text);
    if (!slots) return [send(chatId, "Не вдалося прочитати розклад. Приклад: <code>Пн 18:00, 19:00; Ср 10:00</code>")];
    flows.delete(Number(chatId));
    store.updateUser(chatId, { psy: Object.assign({}, user.psy, { schedule: { slots } }) });
    return [send(chatId, "Розклад збережено: " + escapeHtml(templateText({ slots })) + ".\nВільних вікон на " + BOOKING_DAYS_AHEAD +
      " днів: " + slotsFor(chatId).length + ". Записи: /sessions")];
  }

  function prepAsk(chatId, step) {
    return send(chatId, PREP_STEPS[step].ask, { reply_markup: { inline_keyboard: [[{ text: "Пропустити", callback_data: "pr|skip" }]] } });
  }

  function prepStep(chatId, flow, text) {
    if (text) flow.data[PREP_STEPS[flow.step].key] = text.trim().slice(0, MAX_CARE_TEXT);
    flow.step += 1;
    if (flow.step < PREP_STEPS.length) {
      setFlow(chatId, flow);
      return [prepAsk(chatId, flow.step)];
    }
    flows.delete(Number(chatId));
    const found = findBooking(chatId, flow.booking);
    if (!found || found.booking.status === "canceled") return [send(chatId, "Цей запис уже скасовано.")];
    found.booking.prep = { changed: flow.data.changed || "", hard: flow.data.hard || "", talk: flow.data.talk || "" };
    found.booking.summarySentAt = new Date(now()).toISOString();
    store.touch();
    return [send(chatId, "Дякую, відповіді надіслано фахівцю. До зустрічі!"),
      sessionCardAction(found.booking.psy, found.client, found.booking, "Підготовка до сесії")];
  }

  // Unasked messages about sessions: the prep the day before (daytime), and
  // the summary two hours before when the prep was not filled in. A booked
  // session is the person's own appointment, so these go out even when the
  // daily reminders have fallen silent.
  function sessionHabits() {
    const actions = [];
    store.allUsers().forEach((user) => {
      user.bookings.forEach((booking) => {
        if (booking.status === "canceled" || booking.at <= now()) return;
        const left = booking.at - now();
        const share = activeShare(user, booking.psy);
        if (!share || !stateOf(booking.psy).active) return;
        const minutes = localMinutes(scheduleFor(user.chatId), now());
        if (!booking.prepAskedAt && left <= 30 * 3600000 && left > 3 * 3600000 && minutes >= 10 * 60 && minutes < 21 * 60) {
          booking.prepAskedAt = new Date(now()).toISOString();
          store.touch();
          actions.push(send(user.chatId, "🗓 Скоро сесія: " + escapeHtml(psyName(booking.psy)) + ", " + escapeHtml(whenFor(booking.psy, booking.at)) +
            ".\n\nЩоб зустріч була кориснішою, дайте відповідь на 3 короткі питання. Відповіді побачить лише " +
            escapeHtml(psyName(booking.psy)) + ".", { reply_markup: { inline_keyboard: [[
            { text: "Відповісти", callback_data: "pr|go|" + booking.id }, { text: "Не зараз", callback_data: "pr|no" },
          ]] } }));
        }
        if (!booking.summarySentAt && left <= 2 * 3600000) {
          booking.summarySentAt = new Date(now()).toISOString();
          store.touch();
          actions.push(sessionCardAction(booking.psy, user, booking, "Зведення до сесії", true));
        }
      });
    });
    return actions;
  }

  // A flow's text, or null when no flow is waiting for text.
  function flowText(chatId, text) {
    const flow = flowOf(chatId);
    if (!flow || !text.trim()) return null;
    if (flow.kind === "plan") return planStep(chatId, flow, text);
    if (flow.kind === "diary") {
      if (DIARY_STEPS[flow.step].scale) {
        const value = Number(text.trim());
        if (!Number.isInteger(value) || value < 0 || value > 100) return [diaryAsk(chatId, flow.step)];
        return diaryStep(chatId, flow, value);
      }
      return diaryStep(chatId, flow, text);
    }
    if (flow.kind === "topic") return createBooking(chatId, flow, text);
    if (flow.kind === "prep") return prepStep(chatId, flow, text);
    if (flow.kind === "schedule") return scheduleSave(chatId, text);
    return null;
  }

  // Taps for the care features, or null for any other data.
  function careCallback(chatId, parts) {
    const key = parts[0];
    if (key === "pl") {
      if (parts[1] === "start") {
        sessions.clearAll(chatId);
        setFlow(chatId, { kind: "plan", step: 0, data: Object.assign({}, store.user(chatId).safetyPlan || {}) });
        delete flowOf(chatId).data.updatedAt;
        return [planAsk(chatId, 0)];
      }
      const flow = flowOf(chatId);
      if (parts[1] === "skip" && flow && flow.kind === "plan") return planStep(chatId, flow, "");
      return [];
    }
    if (key === "dy") {
      if (parts[1] === "new") {
        sessions.clearAll(chatId);
        setFlow(chatId, { kind: "diary", step: 0, data: {} });
        return [diaryAsk(chatId, 0)];
      }
      if (parts[1] === "b" || parts[1] === "a") {
        const flow = flowOf(chatId);
        const value = Number(parts[2]);
        const expected = parts[1] === "b" ? "before" : "after";
        if (!flow || flow.kind !== "diary" || DIARY_STEPS[flow.step].key !== expected || !Number.isInteger(value) || value < 0 || value > 100) return [];
        return diaryStep(chatId, flow, value);
      }
      if (parts[1] === "list") {
        const entries = store.user(chatId).diary.slice(-5).reverse();
        if (!entries.length) return [send(chatId, "Записів ще немає.", { reply_markup: diaryIntroKeyboard() })];
        return entries.map((entry) => send(chatId, diaryEntryText(entry, dateFor(chatId, Date.parse(entry.at)))));
      }
      if (parts[1] === "s") {
        const entry = store.user(chatId).diary.find((item) => item.id === parts[2]);
        const psyChatId = Number(parts[3]);
        if (!entry || !consentedSpecialists(chatId).some((specialist) => specialist.chatId === psyChatId)) {
          return [send(chatId, "Надіслати можна лише фахівцю, якому Ви надали згоду.")];
        }
        if (entry.sentTo.indexOf(psyChatId) === -1) entry.sentTo.push(psyChatId);
        store.touch();
        const share = activeShare(store.user(chatId), psyChatId);
        return [send(psyChatId, "Від клієнта " + escapeHtml(share.clientName || "Клієнт") + ":\n\n" + diaryEntryText(entry, dateFor(psyChatId, Date.parse(entry.at)))),
          send(chatId, "Надіслано: " + escapeHtml(psyName(psyChatId)) + ".")];
      }
      return [];
    }
    if (key === "sb") {
      const psyChatId = Number(parts[1]);
      if (!mayBook(chatId, psyChatId)) return [send(chatId, "Записатися можна лише до фахівця, якому Ви надали згоду.")];
      const rows = dayRows(psyChatId);
      return [send(chatId, rows.length ? "Оберіть день:" : "Вільних вікон зараз немає.", rows.length ? { reply_markup: { inline_keyboard: rows } } : {})];
    }
    if (key === "sd") {
      const psyChatId = Number(parts[1]);
      if (!mayBook(chatId, psyChatId) || !/^\d{8}$/.test(parts[2] || "")) return [];
      const rows = timeRows(psyChatId, parts[2]);
      return [send(chatId, rows.length ? "Оберіть час:" : "На цей день вільних вікон уже немає. /session", rows.length ? { reply_markup: { inline_keyboard: rows } } : {})];
    }
    if (key === "st") return chooseTime(chatId, Number(parts[1]), Number(parts[2]));
    if (key === "bk") {
      const flow = flowOf(chatId);
      return flow && flow.kind === "topic" ? createBooking(chatId, flow, "") : [];
    }
    if (key === "sc") {
      const found = findBooking(chatId, parts[1]);
      if (!found || found.booking.status === "canceled") return [send(chatId, "Цей запис уже скасовано.")];
      return cancelBooking(found, "client");
    }
    if (key === "bc" || key === "bx" || key === "bv") {
      const denied = requireActive(chatId);
      if (denied) return denied;
      const found = findBooking(Number(parts[1]), parts[2]);
      if (!found || found.booking.psy !== Number(chatId)) return [send(chatId, "Запис не знайдено.")];
      if (key === "bv") return [sessionCardAction(chatId, found.client, found.booking, "Запис")];
      if (found.booking.status === "canceled") return [send(chatId, "Цей запис уже скасовано.")];
      if (key === "bx") return cancelBooking(found, "psy");
      found.booking.status = "confirmed";
      store.touch();
      return [send(chatId, "Підтверджено: " + escapeHtml(whenFor(chatId, found.booking.at)) + "."),
        send(found.client.chatId, "✅ " + escapeHtml(psyName(chatId)) + " підтверджує запис: " + escapeHtml(whenFor(chatId, found.booking.at)) + ".")];
    }
    if (key === "pr") {
      if (parts[1] === "go") {
        const found = findBooking(chatId, parts[2]);
        if (!found || found.booking.status === "canceled") return [send(chatId, "Цей запис уже скасовано.")];
        sessions.clearAll(chatId);
        setFlow(chatId, { kind: "prep", step: 0, booking: found.booking.id, data: {} });
        return [prepAsk(chatId, 0)];
      }
      if (parts[1] === "skip") {
        const flow = flowOf(chatId);
        return flow && flow.kind === "prep" ? prepStep(chatId, flow, "") : [];
      }
      return [send(chatId, "Добре. Фахівець отримає зведення з балами перед зустріччю.")];
    }
    if (key === "ss") return scheduleAsk(chatId);
    return null;
  }

  // ---------------------------------------------------------- homework

  // A specialist who tapped "Дати домашнє завдання" and has not written it
  // yet. In memory on purpose: a restart only means tapping again.
  const homeworkDrafts = new Map();
  const HOMEWORK_DRAFT_MS = 30 * 60 * 1000;

  function homeworkDraft(chatId) {
    const draft = homeworkDrafts.get(Number(chatId));
    if (!draft) return null;
    if (now() - draft.at > HOMEWORK_DRAFT_MS) {
      homeworkDrafts.delete(Number(chatId));
      return null;
    }
    return draft;
  }

  // The same three checks as a client card: approved, paid up, consent in force.
  function homeworkStart(chatId, clientChatId) {
    const denied = requireActive(chatId);
    if (denied) return denied;
    const client = store.hasUser(clientChatId) ? store.user(clientChatId) : null;
    const share = activeShare(client, chatId);
    if (!share) return [send(chatId, "Цей клієнт не надав згоди або відкликав її.")];
    sessions.clearAll(chatId);
    homeworkDrafts.set(Number(chatId), { client: Number(clientChatId), at: now() });
    return [send(chatId, homeworkAsk(share.clientName))];
  }

  function homeworkSave(chatId, draft, text) {
    homeworkDrafts.delete(Number(chatId));
    const body = text.trim().slice(0, MAX_HOMEWORK_TEXT);
    if (!body) return [];
    const client = store.hasUser(draft.client) ? store.user(draft.client) : null;
    const share = activeShare(client, chatId);
    if (!share || requireActive(chatId)) return [send(chatId, "Не вдалося надіслати: згоди клієнта або доступу до кабінету вже немає.")];
    const entry = {
      id: randomBytes(6).toString("hex"), psy: Number(chatId), text: body,
      createdAt: new Date(now()).toISOString(), doneAt: null,
    };
    store.updateUser(draft.client, { homework: client.homework.concat([entry]).slice(-MAX_HOMEWORK_PER_USER) });
    return [
      send(chatId, homeworkSent(share.clientName)),
      send(draft.client, homeworkForClient(psyName(chatId), body), { reply_markup: homeworkDoneKeyboard(entry.id) }),
    ];
  }

  function homeworkDone(chatId, id) {
    const user = store.hasUser(chatId) ? store.user(chatId) : null;
    const entry = user ? user.homework.find((item) => item.id === id) : null;
    if (!entry) return { note: "Завдання не знайдено", actions: [] };
    if (entry.doneAt) return { note: "Вже позначено", actions: [] };
    entry.doneAt = new Date(now()).toISOString();
    store.touch();
    // The specialist hears back only while the consent still stands.
    const share = activeShare(user, entry.psy);
    const actions = [send(chatId, "✅ Позначено виконаним. Молодець, що зробили це!")];
    if (share) actions.push(send(entry.psy, homeworkDoneForPsy(share.clientName, entry.text)));
    return { note: "Виконано", actions };
  }

  // /homework: the person's own tasks, and for an active specialist the
  // client picker as well.
  function homeworkActions(chatId) {
    const user = store.user(chatId);
    const actions = [];
    const psyActive = stateOf(chatId).active && user.psy;
    if (user.homework.length || !psyActive) {
      const dateOf = (iso) => dateFor(chatId, Date.parse(iso));
      const keyboard = homeworkListKeyboard(user.homework);
      actions.push(send(chatId, homeworkList(user.homework, psyName, dateOf), keyboard ? { reply_markup: keyboard } : {}));
    }
    if (psyActive) {
      const clients = clientsOf(store, chatId).map((entry) => ({
        chatId: entry.user.chatId, label: entry.share.clientName || "Клієнт",
      }));
      const keyboard = homeworkPickKeyboard(clients);
      actions.push(send(chatId, homeworkPickClient(clients.length > 0), keyboard ? { reply_markup: keyboard } : {}));
    }
    return actions;
  }

  // The privacy policy lives next to the Mini App, so it exists only when the
  // app is hosted.
  function policyLine() {
    if (!config.webappUrl) return "";
    const url = config.webappUrl.split("?")[0].replace(/[^/]*$/, "") + "privacy";
    return "\n\nПолітика конфіденційності: " + escapeHtml(url);
  }

  // A crisis phrase: the fact and the time go to each specialist the person
  // consented to under a version that names this signal, and only while the
  // cabinet is active. Never the words. One signal an hour at most.
  function crisisSignalActions(chatId) {
    const client = store.user(chatId);
    if (client.crisisSignalAt && now() - Date.parse(client.crisisSignalAt) < 60 * 60000) return [];
    const targets = client.shares.filter((share) => !share.revokedAt && allowsCrisisSignal(share) && stateOf(share.psy).active);
    if (!targets.length) return [];
    store.updateUser(chatId, { crisisSignalAt: new Date(now()).toISOString() });
    return targets.map((share) => send(share.psy, psyCrisisSignal(share.clientName,
      formatLocalDateTime(now(), offsetAt(scheduleFor(share.psy), now()))), {
      reply_markup: { inline_keyboard: [[{ text: "Картка клієнта", callback_data: "cl|" + chatId }]] },
    }));
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
      ", нотатки " + (share.notes ? "видно" : "приховані") + (allowsCrisisSignal(share) ? "" : ", попередня версія згоди"));
    const keyboard = privacyKeyboard(shares.map((share) => ({
      psy: share.psy, name: psyName(share.psy), notes: share.notes, outdated: !allowsCrisisSignal(share),
    })));
    const outdated = shares.some((share) => !allowsCrisisSignal(share));
    const text = privacyMessage(rows) + (outdated ? "\n\n" + consentOutdatedLine() : "") + policyLine();
    return [send(chatId, text, keyboard ? { reply_markup: keyboard } : {})];
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
    // The client's sessions go with their data; each specialist is told.
    upcomingOf(chatId).forEach((booking) => {
      actions.push(send(booking.psy, "Запис скасовано: клієнт видалив свої дані (" + escapeHtml(whenFor(booking.psy, booking.at)) + ")."));
    });
    if (user.psy) {
      clientsOf(store, chatId).forEach((entry) => {
        actions.push(...cancelBetween(entry.user.chatId, chatId));
        revokeShare(store, entry.user.chatId, chatId, "psy", now());
        actions.push(send(entry.user.chatId, psyGone(user.psy.name || "фахівець")));
      });
    }
    return actions;
  }

  function locked(chatId, state) {
    if (atRisk(chatId)) return [send(chatId, lockedGentle())];
    countFunnel("paywall");
    return [send(chatId, paywall(config.price, state), { reply_markup: buyKeyboard(config.price) })];
  }

  // "⭐ Повний доступ" and /buy: the whole offer, with the pay button unless
  // it is already bought.
  function accessActions(chatId) {
    startTrialFor(chatId);
    const state = access(chatId);
    const text = accessOffer(config.price, state);
    if (state.kind === "pro") return [send(chatId, text)];
    countFunnel("paywall");
    return [send(chatId, text, { reply_markup: buyKeyboard(config.price) })];
  }

  // The greeting's buttons. Someone without a result yet also gets one
  // obvious next step at the bottom, where the greeting ends.
  function greetingKeyboard(chatId, unlocked) {
    const keyboard = startKeyboard(unlocked);
    if (store.user(chatId).results.length) return keyboard;
    return { inline_keyboard: keyboard.inline_keyboard.concat(startCtaKeyboard().inline_keyboard) };
  }

  // Free text the bot was not waiting for: a simple intent, or the menu.
  function freeTextActions(chatId, text, message) {
    const intent = detectIntent(text);
    if (intent === "greeting") {
      const name = message && message.from && message.from.first_name;
      return [send(chatId, shortGreeting(name), { reply_markup: startCtaKeyboard() })];
    }
    if (intent === "price" && !atRisk(chatId)) return accessActions(chatId);
    if (intent === "test") return menuActions(chatId, "tests");
    if (intent === "help") return handleCommand(chatId, { command: "contact", args: "" }, message);
    return [send(chatId, friendlyUnknown(), { reply_markup: mainKeyboard(chatId) })];
  }

  // The menu under the input field. The main screen offers "⭐ Повний доступ"
  // to anyone who has not bought; a section marks what is locked.
  function menuOptions(chatId) {
    const state = access(chatId);
    return { webappUrl: appUrl(state, chatId), offer: state.kind !== "pro", unlocked: state.active, admin: isAdmin(chatId) };
  }

  function mainKeyboard(chatId) {
    return menuKeyboard("main", menuOptions(chatId));
  }

  function menuActions(chatId, sectionId) {
    startTrialFor(chatId);
    const options = menuOptions(chatId);
    const actions = [send(chatId, menuText(sectionId, options), { reply_markup: menuKeyboard(sectionId, options) })];
    // The menu button beside the input field is set once for every chat with
    // the bare address, so a window opened from it would not know what is
    // unlocked. The main screen refreshes this chat's own button with the
    // same hints the keyboard button carries.
    if (sectionId === "main" && options.webappUrl) actions.unshift(menuButtonAction(chatId, options.webappUrl));
    return actions;
  }

  function menuButtonAction(chatId, url) {
    return {
      method: "setChatMenuButton",
      payload: { chat_id: chatId, menu_button: { type: "web_app", text: "Застосунок", web_app: { url } } },
    };
  }

  // A tapped menu button: a screen, a questionnaire, or what its command does.
  function menuTargetActions(chatId, target, message) {
    if (target.section) return menuActions(chatId, target.section);
    if (target.instrument) return startInstrument(chatId, getInstrument(target.instrument));
    return handleCommand(chatId, { command: target.command, args: "" }, message);
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
    if (!store.user(chatId).results.length) countFunnel("firstTest");
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
        // What a window opened from the menu button sends instead of sendData.
        const fromApp = args ? parseStartCode(args) : null;
        if (fromApp && fromApp.command) return handleCommand(chatId, { command: fromApp.command, args: "" }, message);
        if (fromApp && fromApp.data) return handleWebAppData(chatId, fromApp.data).actions;
        if (args.indexOf(INVITE_PREFIX) === 0) {
          if (!store.user(chatId).firstSeenAt) store.updateUser(chatId, { firstSeenAt: new Date(now()).toISOString() });
          startTrialFor(chatId);
          return consentStart(chatId, args.slice(INVITE_PREFIX.length));
        }
        if (!store.user(chatId).firstSeenAt) {
          store.updateUser(chatId, { firstSeenAt: new Date(now()).toISOString() });
          countFunnel("start");
        }
        startTrialFor(chatId);
        const state = access(chatId);
        const hello = send(chatId,
          greeting(message && message.from && message.from.first_name, scheduleFor(chatId),
            { extra: trialNotice(state, config.price), remindersActive: state.active }),
          { reply_markup: greetingKeyboard(chatId, state.active) });
        // The greeting keeps its inline shortcuts; the second message brings up
        // the menu under the input field, with "Мені зараз погано" in reach.
        return [hello].concat(menuActions(chatId, "main"));
      }
      case "app":
        if (!config.webappUrl) {
          return [send(chatId, "Застосунок не налаштований. Опитувальники доступні тут: /gad7, /phq9.")];
        }
        startTrialFor(chatId);
        return [send(chatId, appIntro(), { reply_markup: mainKeyboard(chatId) })];
      case "menu":
        return menuActions(chatId, "main");
      case "help":
        return [send(chatId, helpText(), { reply_markup: startKeyboard(access(chatId).active) })];
      case "about":
        return [send(chatId, aboutText(reminderLine(chatId)) + policyLine())];
      case "buy":
        return accessActions(chatId);
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
      case "homework":
        return homeworkActions(chatId);
      case "plan":
        return planCommand(chatId);
      case "diary":
        return [send(chatId, diaryIntro(), { reply_markup: diaryIntroKeyboard() })];
      case "insights":
        return insightsActions(chatId);
      case "session":
        return sessionCommand(chatId);
      case "sessions":
        return sessionsForPsy(chatId);
      case "schedule":
        return scheduleAsk(chatId);
      case "privacy":
        return privacyActions(chatId);
      case "admin":
        return adminList(chatId);
      case "stats":
        return statsActions(chatId);
      case "cancel": {
        if (flowOf(chatId)) {
          flows.delete(Number(chatId));
          return [send(chatId, "Перервано. Повернутися можна будь-коли.")];
        }
        if (homeworkDraft(chatId)) {
          homeworkDrafts.delete(Number(chatId));
          return [send(chatId, "Завдання не надіслано.")];
        }
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
          homework: user.homework,
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
      if (!store.user(chatId).results.length) countFunnel("firstTest");
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
      return { actions: [send(chatId, moodDone(entry, weekAverage(chatId)), extra)].concat(moodSummaryActions(chatId)), payload };
    }

    if (payload.type === "report") {
      return { actions: reportActions(chatId, payload.includeNotes), payload };
    }

    // The app's pay button. The window has closed by now, so the invoice
    // arrives in the chat.
    if (payload.type === "buy") {
      return { actions: handleInvoice(chatId), payload };
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
    countFunnel("invoice");
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
    countFunnel("paid");
    const thanks = [send(chatId, purchaseThanks(config.price), { reply_markup: mainKeyboard(chatId) })];
    const url = appUrl(access(chatId), chatId);
    return url ? [menuButtonAction(chatId, url)].concat(thanks) : thanks;
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
    noteActivity(chatId);
    if (message.successful_payment) return handleSuccessfulPayment(chatId, message.successful_payment);
    if (message.web_app_data) return handleWebAppData(chatId, message.web_app_data.data).actions;
    if (isSosText(text)) return sosActions(chatId);
    // Keyboard buttons, so never an answer, a note or a request text.
    if (isAccessText(text)) return accessActions(chatId);
    const target = menuTarget(text);
    if (target) return menuTargetActions(chatId, target, message);
    if (parsed) return handleCommand(chatId, parsed, message);
    const draft = homeworkDraft(chatId);
    if (draft && text.trim()) return homeworkSave(chatId, draft, text);
    // A crisis typed as text gets the help block first, whatever the bot was
    // waiting for; the text itself still goes where it was going.
    if (detectCrisis(text)) {
      store.updateUser(chatId, { crisisAt: new Date(now()).toISOString() });
      const rest = textActions(chatId, text, message, true);
      return [sosBlock(chatId)].concat(planActions(chatId), rest, crisisSignalActions(chatId));
    }
    return textActions(chatId, text, message, false);
  }

  // Text that is not a command or a button: an application, a booking
  // request, a weekly note, a digit answer, or free text. After a crisis
  // phrase the help block has already been sent, so free text adds nothing.
  function textActions(chatId, text, message, afterCrisis) {
    const flowReply = flowText(chatId, text);
    if (flowReply) return flowReply;
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
    if (!text || afterCrisis) return [];
    return freeTextActions(chatId, text, message);
  }

  function handleCallback(query) {
    const message = query.message || {};
    const chat = message.chat || {};
    const chatId = chat.id;
    const data = typeof query.data === "string" ? query.data : "";
    if (chatId === undefined || chatId === null) return [ack(query.id)];
    if (chat.type && chat.type !== "private") return [ack(query.id), send(chatId, PRIVATE_ONLY)];
    noteAdmin(chatId, query.from);
    noteActivity(chatId);

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
    const care = careCallback(chatId, parts);
    if (care) return [ack(query.id)].concat(care);
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
    if (parts[0] === "dm") {
      const user = store.user(chatId);
      const enabled = parts[1] === "on";
      user.dailyMood = Object.assign({}, user.dailyMood, { offered: true, enabled, unanswered: 0 });
      store.touch();
      return [ack(query.id), send(chatId, dailyMoodSet(enabled))];
    }
    if (parts[0] === "acc") return [ack(query.id)].concat(accessActions(chatId));
    if (parts[0] === "mn") return [ack(query.id)].concat(menuActions(chatId, parts[1] === "tests" ? "tests" : "main"));
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
      return [ack(query.id, "Збережено"), saved].concat(moodSummaryActions(chatId));
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
      if (parts[1] === "homework") return [ack(query.id)].concat(homeworkActions(chatId));
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
    if (parts[0] === "cu") {
      const psyChatId = Number(parts[1]);
      const share = updateShareVersion(store, chatId, psyChatId, now());
      if (!share) return [ack(query.id)];
      return [ack(query.id, "Згоду оновлено"), send(chatId, consentUpdated(psyName(psyChatId)))];
    }
    if (parts[0] === "rv") {
      const psyChatId = Number(parts[1]);
      const share = revokeShare(store, chatId, psyChatId, "client", now());
      if (!share) return [ack(query.id), send(chatId, "Цю згоду вже відкликано.")];
      return [ack(query.id, "Згоду відкликано"), send(chatId, revoked(psyName(psyChatId))),
        send(psyChatId, psyClientRevoked(share.clientName))].concat(cancelBetween(chatId, psyChatId));
    }
    if (parts[0] === "cl") return [ack(query.id)].concat(clientCard(chatId, Number(parts[1])));
    if (parts[0] === "hw") return [ack(query.id)].concat(homeworkStart(chatId, Number(parts[1])));
    if (parts[0] === "hd") {
      const outcome = homeworkDone(chatId, parts[1]);
      return [ack(query.id, outcome.note)].concat(outcome.actions);
    }
    if (parts[0] === "clr") return [ack(query.id, "Готую звіт")].concat(clientReport(chatId, Number(parts[1])));
    if (parts[0] === "cld") {
      const clientChatId = Number(parts[1]);
      const share = revokeShare(store, clientChatId, chatId, "psy", now());
      if (!share) return [ack(query.id)];
      return [ack(query.id), send(chatId, psyDisconnected(share.clientName)),
        send(clientChatId, clientDisconnectedByPsy(psyName(chatId)))].concat(cancelBetween(clientChatId, chatId));
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
      return [ack(query.id), send(chatId, noteSkipped(), { reply_markup: startKeyboard(access(chatId).active) })]
        ;
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
    reminderActions, habitActions, access, atRisk, instruments: INSTRUMENT_LIST,
  };
}
