// One-time purchase in Telegram Stars, with a free trial before it.
// Zero dependencies. Node 16+.
//
// Telegram requires digital goods inside a bot to be sold in Stars (currency
// XTR), so there is no provider token and no card data anywhere in this file.
// The flow is: sendInvoice with XTR, answer the pre-checkout query within ten
// seconds, then read `successful_payment` and record the charge id, which is
// the only handle a refund needs later.
//
// Access is a pure function of the stored user and the clock, so every gate in
// the bot asks the same question and tests need no timers.

export const PAYLOAD_PREFIX = "pro-v1";
export const DAY_MS = 24 * 60 * 60 * 1000;

// Free forever: taking GAD-7 and PHQ-9, the result with its crisis block and
// the weekly note. Plus /export and /delete, which are access to one's own
// health data rather than a feature to sell, and every route to help: the
// self-help practices, "Мені зараз погано", the specialist report and the
// consultation request. Everything else is the one-time purchase: the other
// scales, the mood check-in, history, statistics, the reminder and its settings.

export function trialEndsAt(user) {
  return Number.isFinite(user && user.trialEndsAt) ? Number(user.trialEndsAt) : null;
}

export function isPro(user) {
  return Boolean(user && user.pro && user.pro.chargeId);
}

// { active, kind, daysLeft } where kind is one of pro, trial, expired, none.
export function entitlement(user, nowMs) {
  if (isPro(user)) return { active: true, kind: "pro", daysLeft: null };
  const ends = trialEndsAt(user);
  if (ends === null) return { active: false, kind: "none", daysLeft: null };
  if (nowMs < ends) {
    return { active: true, kind: "trial", daysLeft: Math.max(1, Math.ceil((ends - nowMs) / DAY_MS)) };
  }
  return { active: false, kind: "expired", daysLeft: 0 };
}

// Starts the trial once and never restarts it: a user who lets it lapse cannot
// reset the clock by sending /start again.
export function ensureTrial(store, chatId, nowMs, trialDays) {
  const user = store.user(chatId);
  if (trialEndsAt(user) !== null || isPro(user)) return user;
  return store.updateUser(chatId, { trialEndsAt: nowMs + Math.max(1, Number(trialDays)) * DAY_MS });
}

export function invoiceFor(chatId, price) {
  return {
    chat_id: chatId,
    title: price.title,
    description: price.description,
    payload: PAYLOAD_PREFIX + ":" + chatId,
    currency: "XTR",
    // For Stars the amount is the number of Stars, not a minor currency unit,
    // and exactly one price line is allowed.
    prices: [{ label: price.title, amount: Number(price.stars) }],
  };
}

export const ALREADY_PRO = "already purchased";

// Answered within ten seconds or Telegram cancels the payment, so this stays
// synchronous and refuses anything it does not recognize. An older invoice
// stays payable after the purchase, so a second charge is refused here: it
// would bill the person twice for a one-time purchase.
export function checkPreCheckout(query, chatId, user) {
  if (!query || typeof query !== "object") return { ok: false, reason: "empty pre-checkout query" };
  if (query.currency !== "XTR") return { ok: false, reason: "unexpected currency " + String(query.currency) };
  if (query.invoice_payload !== PAYLOAD_PREFIX + ":" + chatId) {
    return { ok: false, reason: "payload does not belong to this chat" };
  }
  if (isPro(user)) return { ok: false, reason: ALREADY_PRO };
  return { ok: true };
}

export function applyPayment(store, chatId, payment, nowMs) {
  if (!payment || payment.currency !== "XTR" || !payment.telegram_payment_charge_id) return null;
  // Two invoices paid before either payment landed both pass the pre-checkout.
  // The first charge stays on record, since a refund of it would close access;
  // the second is handed back for its own refund.
  const existing = store.hasUser(chatId) ? store.user(chatId).pro : null;
  if (existing && existing.chargeId) {
    return Object.assign({}, existing, { duplicateChargeId: String(payment.telegram_payment_charge_id) });
  }
  const record = {
    since: new Date(nowMs).toISOString(),
    stars: Number(payment.total_amount) || 0,
    chargeId: String(payment.telegram_payment_charge_id),
  };
  store.updateUser(chatId, { pro: record });
  return record;
}
