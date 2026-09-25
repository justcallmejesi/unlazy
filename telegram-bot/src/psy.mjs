// Specialist mode: the state of a specialist's account, the monthly Stars
// subscription, invite codes, and the consents clients give. Pure functions
// over the store. Zero dependencies. Node 16+.
//
// Who pays for what: a client pays for the paid features they use, through the
// one-time purchase in billing.mjs. A specialist pays a monthly subscription
// for the client list, the client cards and the alerts. Nothing here unlocks
// a paid feature for a client.
//
// A specialist sees a client's data only while three things hold: the owner
// approved the specialist, the subscription is active (or the specialist is the
// owner), and the client's consent is in force. Every read checks all three.

import { randomBytes } from "node:crypto";

export const PSY_PAYLOAD_PREFIX = "psy-v1";
// The only period Telegram accepts for a Stars subscription: 30 days.
export const SUBSCRIPTION_PERIOD_SECONDS = 2592000;
export const CONSENT_VERSION = "2026-09-v1";
export const TERMS_VERSION = "2026-09-v1";
export const INVITE_PREFIX = "c_";
export const MAX_APPLICATION_FIELD = 300;

// { status, active, kind, expiresAt, canceled }. kind is one of none, pending,
// rejected, admin, subscribed, expired, unsubscribed.
export function psyState(user, nowMs, isAdmin) {
  const psy = user && user.psy;
  if (isAdmin) {
    return { status: psy ? psy.status : "none", active: true, kind: "admin", expiresAt: null, canceled: false };
  }
  if (!psy) return { status: "none", active: false, kind: "none", expiresAt: null, canceled: false };
  if (psy.status !== "approved") {
    return { status: psy.status, active: false, kind: psy.status, expiresAt: null, canceled: false };
  }
  const sub = psy.subscription;
  if (sub && sub.expiresAt > nowMs) {
    return { status: "approved", active: true, kind: "subscribed", expiresAt: sub.expiresAt, canceled: sub.canceled };
  }
  return {
    status: "approved", active: false, kind: sub ? "expired" : "unsubscribed",
    expiresAt: sub ? sub.expiresAt : null, canceled: false,
  };
}

// A subscription is sold through an invoice link: only createInvoiceLink takes
// subscription_period, and Telegram then renews it every 30 days on its own.
export function subscriptionInvoice(chatId, price) {
  return {
    title: price.title,
    description: price.description,
    payload: PSY_PAYLOAD_PREFIX + ":" + chatId,
    currency: "XTR",
    prices: [{ label: price.title, amount: Number(price.stars) }],
    subscription_period: SUBSCRIPTION_PERIOD_SECONDS,
  };
}

export function isSubscriptionPayload(payload) {
  return typeof payload === "string" && payload.indexOf(PSY_PAYLOAD_PREFIX + ":") === 0;
}

// An invoice link can be forwarded, so the payload must name the payer.
export function checkSubscriptionPreCheckout(query, chatId, user) {
  if (!query || typeof query !== "object") return { ok: false, reason: "empty pre-checkout query" };
  if (query.currency !== "XTR") return { ok: false, reason: "unexpected currency " + String(query.currency) };
  if (query.invoice_payload !== PSY_PAYLOAD_PREFIX + ":" + chatId) {
    return { ok: false, reason: "payload does not belong to this chat" };
  }
  if (!user || !user.psy || user.psy.status !== "approved") return { ok: false, reason: "specialist is not approved" };
  return { ok: true };
}

// The first payment and every renewal arrive as successful_payment. The first
// charge id is kept: editUserStarSubscription needs it to cancel or resume.
export function applySubscriptionPayment(store, chatId, payment, nowMs) {
  if (!payment || payment.currency !== "XTR" || !payment.telegram_payment_charge_id) return null;
  const user = store.user(chatId);
  if (!user.psy) return null;
  const previous = user.psy.subscription;
  const fresh = !previous || payment.is_first_recurring === true;
  const expiresAt = Number.isFinite(payment.subscription_expiration_date)
    ? payment.subscription_expiration_date * 1000
    : nowMs + SUBSCRIPTION_PERIOD_SECONDS * 1000;
  const subscription = {
    firstChargeId: fresh ? String(payment.telegram_payment_charge_id) : previous.firstChargeId,
    lastChargeId: String(payment.telegram_payment_charge_id),
    expiresAt,
    stars: Number(payment.total_amount) || 0,
    since: fresh ? new Date(nowMs).toISOString() : previous.since,
    canceled: false,
  };
  store.updateUser(chatId, { psy: Object.assign({}, user.psy, { subscription }) });
  return subscription;
}

export function newInviteCode() {
  return randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 12).padEnd(10, "x");
}

export function findSpecialistByCode(store, code) {
  if (typeof code !== "string" || !/^[A-Za-z0-9]{8,32}$/.test(code)) return null;
  return store.allUsers().find((user) => user.psy && user.psy.inviteCode === code) || null;
}

export function activeShare(user, psyChatId) {
  if (!user || !Array.isArray(user.shares)) return null;
  return user.shares.find((share) => share.psy === Number(psyChatId) && !share.revokedAt) || null;
}

// Clients with a consent in force for this specialist, newest consent first.
export function clientsOf(store, psyChatId) {
  return store.allUsers()
    .map((user) => ({ user, share: activeShare(user, psyChatId) }))
    .filter((entry) => entry.share)
    .sort((left, right) => (left.share.grantedAt < right.share.grantedAt ? 1 : -1));
}

// Recorded with the version the person saw, so a later change of wording
// never stands in for what was actually agreed to.
export function grantShare(store, clientChatId, psyChatId, clientName, nowMs) {
  const user = store.user(clientChatId);
  const existing = activeShare(user, psyChatId);
  if (existing) return existing;
  const share = {
    psy: Number(psyChatId),
    clientName: String(clientName || "").trim().slice(0, 64),
    grantedAt: new Date(nowMs).toISOString(),
    version: CONSENT_VERSION,
    notes: false,
    revokedAt: null,
    revokedBy: null,
  };
  store.updateUser(clientChatId, { shares: user.shares.concat([share]) });
  return share;
}

export function setShareNotes(store, clientChatId, psyChatId, notes) {
  const share = activeShare(store.user(clientChatId), psyChatId);
  if (!share) return null;
  share.notes = Boolean(notes);
  store.touch();
  return share;
}

export function revokeShare(store, clientChatId, psyChatId, by, nowMs) {
  if (!store.hasUser(clientChatId)) return null;
  const share = activeShare(store.user(clientChatId), psyChatId);
  if (!share) return null;
  share.revokedAt = new Date(nowMs).toISOString();
  share.revokedBy = by === "psy" ? "psy" : "client";
  store.touch();
  return share;
}
