// Counts for the owner's /stats. Zero dependencies. Node 16+.
//
// Numbers only, never a name, a score or a note: the owner sees how the bot is
// used, not who used it for what. Health data stays where consent put it.

import { STAR_REWARD_USD, entitlement } from "./billing.mjs";
import { INSTRUMENT_LIST } from "./instruments.mjs";
import { psyState } from "./psy.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function time(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

// The last scale taken or mood marked. Opening a menu or a practice leaves no
// trace in the store, so this is the activity the bot can actually see.
function lastActivity(user) {
  let latest = 0;
  user.results.forEach((entry) => { latest = Math.max(latest, time(entry.completedAt)); });
  user.moods.forEach((entry) => { latest = Math.max(latest, time(entry.at || entry.date)); });
  return latest;
}

// `isAdmin(chatId)` keeps the owner's free cabinet out of the subscriptions.
export function collectStats(users, nowMs, isAdmin) {
  const within = (ms, days) => ms > 0 && ms > nowMs - days * DAY_MS;
  const stats = {
    users: users.length, new7: 0, new30: 0, active7: 0, active30: 0,
    tested: 0, results: 0, byInstrument: {}, moodUsers: 0, reminders: 0,
    trial: 0, expired: 0, pro: 0, proStars: 0,
    psyPending: 0, psyApproved: 0, psySubscribed: 0, psyMonthlyStars: 0, clients: 0,
  };
  INSTRUMENT_LIST.forEach((instrument) => { stats.byInstrument[instrument.id] = 0; });
  users.forEach((user) => {
    const first = time(user.firstSeenAt);
    if (within(first, 7)) stats.new7 += 1;
    if (within(first, 30)) stats.new30 += 1;
    const last = lastActivity(user);
    if (within(last, 7)) stats.active7 += 1;
    if (within(last, 30)) stats.active30 += 1;
    if (user.results.length) stats.tested += 1;
    stats.results += user.results.length;
    user.results.forEach((entry) => {
      if (Object.prototype.hasOwnProperty.call(stats.byInstrument, entry.instrument)) stats.byInstrument[entry.instrument] += 1;
    });
    if (user.moods.length) stats.moodUsers += 1;

    const access = entitlement(user, nowMs);
    if (access.kind === "trial") stats.trial += 1;
    if (access.kind === "expired") stats.expired += 1;
    if (access.kind === "pro") {
      stats.pro += 1;
      stats.proStars += user.pro.stars || 0;
    }
    if (access.active && user.remindersEnabled) stats.reminders += 1;

    if (user.psy && user.psy.status === "pending") stats.psyPending += 1;
    if (user.psy && user.psy.status === "approved") stats.psyApproved += 1;
    const cabinet = psyState(user, nowMs, isAdmin(user.chatId));
    if (cabinet.kind === "subscribed") {
      stats.psySubscribed += 1;
      // A canceled subscription runs to the end of its month and stops there.
      if (!cabinet.canceled) stats.psyMonthlyStars += user.psy.subscription.stars || 0;
    }
    if (user.shares.some((share) => !share.revokedAt)) stats.clients += 1;
  });
  stats.proUsd = stats.proStars * STAR_REWARD_USD;
  stats.psyMonthlyUsd = stats.psyMonthlyStars * STAR_REWARD_USD;
  return stats;
}
