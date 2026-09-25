// Contract between the Mini App and the bot. Zero dependencies. Node 16+.
//
// A Mini App launched from a keyboard button returns data through
// `Telegram.WebApp.sendData`, which arrives as `message.web_app_data`. Telegram
// authenticates the sender but not the contents: the payload is whatever the
// client sent, so every field is validated here before it can reach the store.
// Nothing in it is trusted as a score; the bot rescores the answers itself.

import { getInstrument } from "./instruments.mjs";
import { parseTimeOfDay } from "./reminders.mjs";
import { MAX_NOTE_LENGTH } from "./store.mjs";
import {
  BOOKING_FORMATS, BOOKING_TIMES, MAX_BOOKING_REQUEST, MOOD_MAX, MOOD_MIN, bookingOption, moodTag,
} from "./selfhelp.mjs";

export const PAYLOAD_VERSION = 1;
// Telegram's own ceiling for sendData. Rejected here too, so an oversized
// payload is a clear diagnostic rather than a parse failure.
export const MAX_PAYLOAD_BYTES = 4096;
const MAX_TZ_OFFSET_MINUTES = 14 * 60;

const fail = (reason) => ({ ok: false, reason });

export function parseWebAppPayload(raw) {
  if (typeof raw !== "string" || !raw) return fail("empty payload");
  if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) return fail("payload over " + MAX_PAYLOAD_BYTES + " bytes");

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail("payload is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("payload is not an object");
  if (parsed.v !== PAYLOAD_VERSION) return fail("unsupported payload version " + String(parsed.v));

  if (parsed.type === "result") return parseResult(parsed);
  if (parsed.type === "reminders") return parseReminders(parsed);
  if (parsed.type === "delete") return { ok: true, payload: { type: "delete" } };
  if (parsed.type === "mood") return parseMood(parsed);
  if (parsed.type === "report") return { ok: true, payload: { type: "report", includeNotes: parsed.notes === true } };
  if (parsed.type === "book") return parseBooking(parsed);
  return fail("unknown payload type " + String(parsed.type));
}

function parseResult(parsed) {
  const instrument = getInstrument(String(parsed.instrument));
  if (!instrument) return fail("unknown instrument " + String(parsed.instrument));
  if (!Array.isArray(parsed.answers)) return fail("answers must be an array");
  if (parsed.answers.length !== instrument.items.length) {
    return fail(instrument.title + " needs exactly " + instrument.items.length + " answers");
  }
  const answers = [];
  for (let index = 0; index < parsed.answers.length; index++) {
    const value = parsed.answers[index];
    if (!Number.isInteger(value)) return fail("answer " + index + " is not an integer");
    if (!instrument.items[index].options.some((option) => option.value === value)) {
      return fail("answer " + index + " is outside the option set");
    }
    answers.push(value);
  }
  let note = null;
  if (parsed.note !== undefined && parsed.note !== null) {
    if (typeof parsed.note !== "string") return fail("note must be a string");
    const trimmed = parsed.note.trim();
    if (trimmed) note = trimmed.slice(0, MAX_NOTE_LENGTH);
  }
  return { ok: true, payload: { type: "result", instrumentId: instrument.id, answers, note } };
}

function parseReminders(parsed) {
  const settings = {};
  if (parsed.enabled !== undefined) {
    if (typeof parsed.enabled !== "boolean") return fail("enabled must be a boolean");
    settings.remindersEnabled = parsed.enabled;
  }
  if (parsed.time !== undefined && parsed.time !== null) {
    if (typeof parsed.time !== "string" || !parseTimeOfDay(parsed.time)) return fail("time must be ГГ:ХХ");
    settings.reminderTime = parsed.time;
  }
  if (parsed.tz === "auto") {
    // Clears the user's fixed offset so the configured zone applies again,
    // transitions included. Mirrors /tz auto in the chat.
    settings.tzOffsetMinutes = null;
  } else if (parsed.tz !== undefined && parsed.tz !== null) {
    if (!Number.isInteger(parsed.tz) || Math.abs(parsed.tz) > MAX_TZ_OFFSET_MINUTES) {
      return fail("tz must be whole minutes within 14 hours of UTC, or the string auto");
    }
    settings.tzOffsetMinutes = parsed.tz;
  }
  if (!Object.keys(settings).length) return fail("reminders payload changes nothing");
  return { ok: true, payload: { type: "reminders", settings } };
}

function parseMood(parsed) {
  if (!Number.isInteger(parsed.rating) || parsed.rating < MOOD_MIN || parsed.rating > MOOD_MAX) {
    return fail("rating must be a whole number from " + MOOD_MIN + " to " + MOOD_MAX);
  }
  const raw = parsed.tags === undefined || parsed.tags === null ? [] : parsed.tags;
  if (!Array.isArray(raw)) return fail("tags must be an array");
  const tags = [];
  for (const tag of raw) {
    if (typeof tag !== "string" || !moodTag(tag)) return fail("unknown mood tag " + String(tag));
    if (tags.indexOf(tag) === -1) tags.push(tag);
  }
  return { ok: true, payload: { type: "mood", rating: parsed.rating, tags } };
}

// Every field is optional except the choice lists, which must name a known
// option, so nothing unexpected can reach the draft the person sends.
function parseBooking(parsed) {
  if (!bookingOption(BOOKING_FORMATS, parsed.format)) return fail("unknown booking format " + String(parsed.format));
  if (!bookingOption(BOOKING_TIMES, parsed.time)) return fail("unknown booking time " + String(parsed.time));
  let request = null;
  if (parsed.request !== undefined && parsed.request !== null) {
    if (typeof parsed.request !== "string") return fail("request must be a string");
    const flat = parsed.request.trim().replace(/\s+/g, " ");
    if (flat) request = flat.slice(0, MAX_BOOKING_REQUEST);
  }
  return {
    ok: true,
    payload: { type: "book", format: parsed.format, time: parsed.time, request, scores: parsed.scores === true },
  };
}
