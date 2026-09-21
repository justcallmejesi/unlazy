// Weekly reminder scheduling. Zero dependencies. Node 16+.
//
// Two ways to say when a reminder is due:
//
//   { zone: "Europe/Kyiv" }   the offset is resolved per instant, so the send
//                             time stays at the same local hour across the
//                             March and October transitions
//   { offsetMinutes: 180 }    a fixed offset, which is what /tz stores and
//                             which deliberately does not follow any rule
//
// Zone offsets come from the platform time-zone database through Intl, so a
// rule change (Ukraine abolishing seasonal time, say) arrives with an OS or
// Node update rather than a code change. A Node built without full ICU has no
// time-zone data at all; there the EU rule is computed arithmetically, which
// covers Kyiv and the rest of the EET/CET family.

export const MONDAY = 1;
export const WEDNESDAY = 3;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const DEFAULT_GRACE_MS = 12 * 60 * 60 * 1000;

// Offsets of the zones the fallback understands, in minutes east of UTC.
const FALLBACK_ZONES = {
  "Europe/Kyiv": { standard: 120, summer: 180 },
  "Europe/Kiev": { standard: 120, summer: 180 },
  "Europe/Warsaw": { standard: 60, summer: 120 },
  "Europe/Berlin": { standard: 60, summer: 120 },
  "Europe/London": { standard: 0, summer: 60 },
};

const zoneFormatters = new Map();

function zoneFormatter(zone) {
  if (zoneFormatters.has(zone)) return zoneFormatters.get(zone);
  let formatter = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    // A build without time-zone data throws above; one that silently accepts
    // the name is caught by formatting a known instant below.
    formatter.format(0);
  } catch (error) {
    formatter = null;
  }
  zoneFormatters.set(zone, formatter);
  return formatter;
}

// The instant is formatted in the zone and read back as if it were UTC. The
// difference between the two is the offset in effect at that instant.
function intlOffsetMinutes(zone, timestampMs) {
  const formatter = zoneFormatter(zone);
  if (!formatter) return null;
  const parts = {};
  formatter.formatToParts(new Date(timestampMs)).forEach((part) => { parts[part.type] = part.value; });
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  if (!Number.isFinite(asUtc)) return null;
  return Math.round((asUtc - Math.floor(timestampMs / 1000) * 1000) / 60000);
}

// Last Sunday of `month` (0 based) at `hourUtc`, as a UTC timestamp.
export function lastSundayUtc(year, month, hourUtc) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, lastDay.getUTCDate() - lastDay.getUTCDay(), hourUtc);
}

// The EU rule: summer time runs from 01:00 UTC on the last Sunday of March to
// 01:00 UTC on the last Sunday of October, the same instants in every EU zone.
export function isEuSummerTime(timestampMs) {
  const year = new Date(timestampMs).getUTCFullYear();
  return timestampMs >= lastSundayUtc(year, 2, 1) && timestampMs < lastSundayUtc(year, 9, 1);
}

export function zoneOffsetMinutes(zone, timestampMs) {
  const fromIntl = intlOffsetMinutes(zone, timestampMs);
  if (fromIntl !== null) return fromIntl;
  const fallback = Object.prototype.hasOwnProperty.call(FALLBACK_ZONES, zone) ? FALLBACK_ZONES[zone] : null;
  if (!fallback) return null;
  return isEuSummerTime(timestampMs) ? fallback.summer : fallback.standard;
}

// The offset a schedule uses at a given instant. An explicit offset wins over a
// zone, which is what makes /tz a deliberate opt out of seasonal changes.
export function offsetAt(schedule, timestampMs) {
  if (schedule && Number.isInteger(schedule.offsetMinutes)) return schedule.offsetMinutes;
  if (schedule && schedule.zone) {
    const resolved = zoneOffsetMinutes(schedule.zone, timestampMs);
    if (resolved !== null) return resolved;
  }
  return 0;
}

// Most recent occurrence of `weekday` at `hour:minute` local time, at or before
// `nowMs`, returned as a UTC timestamp.
export function lastDueBefore(nowMs, schedule) {
  const first = lastDueAtOffset(nowMs, schedule, offsetAt(schedule, nowMs));
  const atDue = offsetAt(schedule, first);
  if (atDue === offsetAt(schedule, nowMs)) return first;
  // `now` and the slot sit on opposite sides of a transition, so the slot is
  // recomputed in the offset that was actually in effect when it came round.
  const corrected = lastDueAtOffset(nowMs, schedule, atDue);
  return corrected > nowMs ? corrected - WEEK_MS : corrected;
}

function lastDueAtOffset(nowMs, schedule, offsetMinutes) {
  const { weekday = MONDAY, hour, minute } = schedule;
  const shift = offsetMinutes * 60 * 1000;
  const local = nowMs + shift;
  const localDate = new Date(local);
  const startOfLocalDay = Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate());
  const dueOnLocalDay = startOfLocalDay + hour * 60 * 60 * 1000 + minute * 60 * 1000;
  const daysSinceWeekday = (new Date(startOfLocalDay).getUTCDay() - weekday + 7) % 7;
  let due = dueOnLocalDay - daysSinceWeekday * DAY_MS;
  if (due > local) due -= WEEK_MS;
  return due - shift;
}

export function nextDueAfter(nowMs, schedule) {
  const last = lastDueBefore(nowMs, schedule);
  const naive = last + WEEK_MS;
  const atLast = offsetAt(schedule, last);
  const atNaive = offsetAt(schedule, naive);
  if (atLast === atNaive) return naive;
  // A transition falls between the two slots. Adding seven days keeps the
  // elapsed time, not the wall clock, so the instant is shifted back by the
  // change in offset to land on the same local hour. The reference is the slot
  // the week was added to, never `now`.
  return naive - (atNaive - atLast) * 60 * 1000;
}

export function resolveSchedule(user, defaults) {
  const time = parseTimeOfDay(user && user.reminderTime) || parseTimeOfDay(defaults.time) || { hour: 19, minute: 0 };
  const weekday = Number.isInteger(defaults.weekday) ? defaults.weekday : MONDAY;
  const schedule = { weekday, hour: time.hour, minute: time.minute };
  // A user who ran /tz gets that exact offset. Everyone else follows the
  // configured zone, transitions included.
  if (user && Number.isInteger(user.tzOffsetMinutes)) {
    schedule.offsetMinutes = user.tzOffsetMinutes;
  } else if (defaults.zone) {
    schedule.zone = defaults.zone;
  } else {
    schedule.offsetMinutes = Number.isInteger(defaults.offsetMinutes) ? defaults.offsetMinutes : 0;
  }
  return schedule;
}

// Users whose weekly slot has passed and who have not been reminded for it.
// A slot older than the grace window is skipped instead of firing late.
export function dueReminders(options) {
  const { users, nowMs, defaults } = options;
  const graceMs = options.graceMs === undefined ? DEFAULT_GRACE_MS : Number(options.graceMs);
  const due = [];
  users.forEach((user) => {
    if (!user || user.remindersEnabled === false) return;
    const schedule = resolveSchedule(user, defaults);
    const dueAt = lastDueBefore(nowMs, schedule);
    if (dueAt <= (Number(user.lastRemindedAt) || 0)) return;
    if (nowMs - dueAt > graceMs) return;
    due.push({ chatId: user.chatId, dueAt, schedule });
  });
  return due.sort((left, right) => left.chatId - right.chatId);
}

export function parseTimeOfDay(value) {
  if (typeof value !== "string") return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function formatTimeOfDay(time) {
  const pad = (value) => String(value).padStart(2, "0");
  return pad(time.hour) + ":" + pad(time.minute);
}

// Accepts "+3", "3", "-3:30", "+05:45", "+0330", and a leading UTC or GMT.
// A colon-less form is read as HHMM, so "+0330" is three and a half hours and
// never 330 minutes.
export function parseUtcOffset(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^UTC/i, "").replace(/^GMT/i, "");
  const match = /^([+-])?(\d{1,2})(?::?([0-5]\d))?$/.exec(text);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  const total = sign * (hours * 60 + minutes);
  return Math.abs(total) <= 14 * 60 ? total : null;
}

export function formatUtcOffset(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const pad = (value) => String(value).padStart(2, "0");
  return "UTC" + sign + pad(Math.floor(absolute / 60)) + ":" + pad(absolute % 60);
}

// Local wall-clock rendering for a fixed offset, without Intl time zones.
export function formatLocalDateTime(timestampMs, offsetMinutes) {
  if (!Number.isFinite(timestampMs)) return "дата невідома";
  const local = new Date(timestampMs + offsetMinutes * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return pad(local.getUTCDate()) + "." + pad(local.getUTCMonth() + 1) + "." + local.getUTCFullYear() +
    " " + pad(local.getUTCHours()) + ":" + pad(local.getUTCMinutes());
}
