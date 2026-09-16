// Weekly reminder scheduling. Zero dependencies. Node 16+.
//
// The due moment is pure arithmetic over fixed UTC offsets, so it is testable
// without timers and identical on every platform and ICU build. Fixed offsets
// mean daylight-saving transitions shift the local send time by an hour until
// the user updates their offset with /tz.

export const WEDNESDAY = 3;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const DEFAULT_GRACE_MS = 12 * 60 * 60 * 1000;

// Most recent occurrence of `weekday` at `hour:minute` local time, at or before
// `nowMs`, returned as a UTC timestamp.
export function lastDueBefore(nowMs, schedule) {
  const { weekday = WEDNESDAY, hour, minute, offsetMinutes } = schedule;
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
  return lastDueBefore(nowMs, schedule) + WEEK_MS;
}

export function resolveSchedule(user, defaults) {
  const time = parseTimeOfDay(user && user.reminderTime) || parseTimeOfDay(defaults.time) || { hour: 10, minute: 0 };
  const offsetMinutes = user && Number.isInteger(user.tzOffsetMinutes)
    ? user.tzOffsetMinutes
    : defaults.offsetMinutes;
  return { weekday: WEDNESDAY, hour: time.hour, minute: time.minute, offsetMinutes };
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
  if (!Number.isFinite(timestampMs)) return "дата неизвестна";
  const local = new Date(timestampMs + offsetMinutes * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return pad(local.getUTCDate()) + "." + pad(local.getUTCMonth() + 1) + "." + local.getUTCFullYear() +
    " " + pad(local.getUTCHours()) + ":" + pad(local.getUTCMinutes());
}
