// In-memory store for users, questionnaire results, and reminder state, with an
// optional durable JSON snapshot. Zero dependencies. Node 16+.
//
// Every read and write goes to the in-memory maps, so the bot never waits on
// disk while a questionnaire is in progress. Snapshots are debounced and
// written atomically (temporary file, fsync, rename) so a crash mid-write
// cannot truncate an existing snapshot.

import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { MOOD_MAX, MOOD_MIN, moodTag } from "./selfhelp.mjs";
import {
  MAX_BOOKINGS_PER_USER, MAX_DIARY_ENTRIES, normalizeBooking, normalizeDiaryEntry, normalizePlan, normalizeSchedule,
} from "./care.mjs";

export const MAX_RESULTS_PER_USER = 200;
export const MAX_NOTE_LENGTH = 1000;
// About thirteen months of daily check-ins.
export const MAX_MOODS_PER_USER = 400;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const SNAPSHOT_VERSION = 1;
// One ceiling for both directions. The writer must never be able to produce a
// snapshot the reader refuses, so `flush` checks the same number before the
// rename and reports what to do instead of leaving an unloadable file behind.
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
// A snapshot is serialized and written whole, so past this size the flush
// starts to block the event loop long enough to be noticed. Measured on the
// reference machine: about 500ms per 40MB.
export const SNAPSHOT_WARN_BYTES = 24 * 1024 * 1024;

function defaultUser(chatId) {
  return {
    chatId,
    firstSeenAt: null,
    remindersEnabled: true,
    reminderTime: null,
    tzOffsetMinutes: null,
    lastRemindedAt: 0,
    trialEndsAt: null,
    pro: null,
    results: [],
    moods: [],
    // A specialist's profile, or null for everyone else.
    psy: null,
    // Consents this person gave to specialists, revoked ones kept as a record.
    shares: [],
    // Homework from specialists, newest last.
    homework: [],
    // A crisis phrase typed as text, ISO time. Like a marked PHQ-9 item 9, it
    // keeps every unasked-for payment prompt away for a while.
    crisisAt: null,
    // When specialists last heard of a crisis message, to send one an hour.
    crisisSignalAt: null,
    // The person's own plan for a hard moment, see care.mjs.
    safetyPlan: null,
    // Thought diary entries, newest last.
    diary: [],
    // Sessions booked with a specialist. Kept with the client, so /delete
    // removes them with everything else.
    bookings: [],
    // The daily mood reminder: offered once after the first result, opt-in.
    // `unanswered` counts reminders sent since the person last wrote; at two
    // the bot falls silent until they come back on their own.
    dailyMood: { offered: false, enabled: false, lastSentDate: null, unanswered: 0 },
    // One-off nudges, ISO times, so each is sent at most once.
    moodSummaryAt: null,
    trialNoticeAt: null,
    // Counted once in the "came back the next day" funnel step.
    returnedCounted: false,
  };
}

// The owner's funnel, counted per local day and never per person, so /delete
// has nothing to take out of it. Kept for FUNNEL_KEEP_DAYS.
export const FUNNEL_STEPS = ["start", "firstTest", "returned", "paywall", "invoice", "paid"];
export const FUNNEL_KEEP_DAYS = 60;

function normalizeFunnel(raw) {
  const funnel = {};
  if (!raw || typeof raw !== "object") return funnel;
  Object.keys(raw).forEach((day) => {
    if (!DATE_KEY.test(day) || !raw[day] || typeof raw[day] !== "object") return;
    const counts = {};
    FUNNEL_STEPS.forEach((step) => {
      const value = raw[day][step];
      if (Number.isInteger(value) && value > 0) counts[step] = value;
    });
    funnel[day] = counts;
  });
  return funnel;
}

function normalizeDailyMood(raw) {
  const base = { offered: false, enabled: false, lastSentDate: null, unanswered: 0 };
  if (!raw || typeof raw !== "object") return base;
  return {
    offered: raw.offered === true,
    enabled: raw.enabled === true,
    lastSentDate: typeof raw.lastSentDate === "string" && DATE_KEY.test(raw.lastSentDate) ? raw.lastSentDate : null,
    unanswered: Number.isInteger(raw.unanswered) && raw.unanswered > 0 ? Math.min(raw.unanswered, 99) : 0,
  };
}

const PSY_STATUSES = ["pending", "approved", "rejected"];

function boundedText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function isoOrNull(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

// A subscription counts only with the charge id Telegram issued, like the
// one-time purchase: a hand-edited expiry grants nothing.
function normalizePsy(raw) {
  if (!raw || typeof raw !== "object" || PSY_STATUSES.indexOf(raw.status) === -1) return null;
  const sub = raw.subscription;
  const subscription = sub && typeof sub === "object" && typeof sub.firstChargeId === "string" && sub.firstChargeId &&
    Number.isFinite(sub.expiresAt)
    ? {
      firstChargeId: sub.firstChargeId,
      lastChargeId: typeof sub.lastChargeId === "string" ? sub.lastChargeId : sub.firstChargeId,
      expiresAt: Number(sub.expiresAt),
      stars: Number(sub.stars) || 0,
      since: isoOrNull(sub.since),
      canceled: sub.canceled === true,
    }
    : null;
  return {
    status: raw.status,
    name: boundedText(raw.name, 120),
    credentials: boundedText(raw.credentials, 400),
    username: boundedText(raw.username, 32),
    appliedAt: isoOrNull(raw.appliedAt),
    decidedAt: isoOrNull(raw.decidedAt),
    termsVersion: boundedText(raw.termsVersion, 32),
    inviteCode: typeof raw.inviteCode === "string" && /^[A-Za-z0-9]{8,32}$/.test(raw.inviteCode) ? raw.inviteCode : null,
    subscription,
    schedule: normalizeSchedule(raw.schedule),
  };
}

function normalizeShare(raw) {
  if (!raw || typeof raw !== "object" || !Number.isInteger(raw.psy)) return null;
  const grantedAt = isoOrNull(raw.grantedAt);
  if (!grantedAt) return null;
  return {
    psy: raw.psy,
    clientName: boundedText(raw.clientName, 64),
    grantedAt,
    version: boundedText(raw.version, 32),
    updatedAt: isoOrNull(raw.updatedAt),
    notes: raw.notes === true,
    revokedAt: isoOrNull(raw.revokedAt),
    revokedBy: raw.revokedBy === "psy" || raw.revokedBy === "client" ? raw.revokedBy : null,
  };
}

// Homework a specialist gave this person. Kept while the consent it was given
// under is in force; the text is the specialist's, bounded like a note.
export const MAX_HOMEWORK_TEXT = 1000;
export const MAX_HOMEWORK_PER_USER = 50;

function normalizeHomework(raw) {
  if (!raw || typeof raw !== "object" || !Number.isInteger(raw.psy)) return null;
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9]{4,16}$/.test(raw.id)) return null;
  const text = boundedText(raw.text, MAX_HOMEWORK_TEXT);
  const createdAt = isoOrNull(raw.createdAt);
  if (!text || !createdAt) return null;
  return { id: raw.id, psy: raw.psy, text, createdAt, doneAt: isoOrNull(raw.doneAt) };
}

// One check-in per local day: a rating from 1 to 10 and any known tags. An
// entry that does not fit that shape is dropped rather than shown.
function normalizeMood(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.date !== "string" || !DATE_KEY.test(raw.date)) return null;
  if (!Number.isInteger(raw.rating) || raw.rating < MOOD_MIN || raw.rating > MOOD_MAX) return null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag, index, all) => typeof tag === "string" && moodTag(tag) && all.indexOf(tag) === index)
    : [];
  return { date: raw.date, rating: raw.rating, tags, at: typeof raw.at === "string" ? raw.at : null };
}

function normalizeUser(chatId, raw) {
  const user = defaultUser(chatId);
  if (!raw || typeof raw !== "object") return user;
  user.firstSeenAt = typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : null;
  user.remindersEnabled = raw.remindersEnabled !== false;
  user.reminderTime = typeof raw.reminderTime === "string" ? raw.reminderTime : null;
  user.tzOffsetMinutes = Number.isInteger(raw.tzOffsetMinutes) ? raw.tzOffsetMinutes : null;
  user.lastRemindedAt = Number.isFinite(raw.lastRemindedAt) ? Number(raw.lastRemindedAt) : 0;
  user.trialEndsAt = Number.isFinite(raw.trialEndsAt) ? Number(raw.trialEndsAt) : null;
  // A purchase is only honoured with the charge id Telegram issued, which is
  // also what a refund needs. A hand-written "pro": true grants nothing.
  user.pro = raw.pro && typeof raw.pro === "object" && typeof raw.pro.chargeId === "string" && raw.pro.chargeId
    ? { since: String(raw.pro.since || ""), stars: Number(raw.pro.stars) || 0, chargeId: raw.pro.chargeId }
    : null;
  // A result without an instrument id or a numeric score cannot be displayed
  // or compared, so it is dropped rather than rendered as "undefined".
  user.results = Array.isArray(raw.results)
    ? raw.results.filter((entry) => entry && typeof entry === "object" &&
      typeof entry.instrument === "string" && Number.isFinite(entry.score))
    : [];
  // A note from a hand-edited snapshot is bounded before it can be rendered.
  user.results.forEach((entry) => {
    if (typeof entry.note !== "string" || !entry.note.trim()) {
      delete entry.note;
      return;
    }
    entry.note = entry.note.trim().slice(0, MAX_NOTE_LENGTH);
  });
  user.moods = Array.isArray(raw.moods)
    ? raw.moods.map(normalizeMood).filter(Boolean).sort((left, right) => (left.date < right.date ? -1 : 1))
      .slice(-MAX_MOODS_PER_USER)
    : [];
  user.psy = normalizePsy(raw.psy);
  user.shares = Array.isArray(raw.shares) ? raw.shares.map(normalizeShare).filter(Boolean) : [];
  user.homework = Array.isArray(raw.homework)
    ? raw.homework.map(normalizeHomework).filter(Boolean).slice(-MAX_HOMEWORK_PER_USER)
    : [];
  user.crisisAt = isoOrNull(raw.crisisAt);
  user.crisisSignalAt = isoOrNull(raw.crisisSignalAt);
  user.safetyPlan = normalizePlan(raw.safetyPlan);
  user.diary = Array.isArray(raw.diary) ? raw.diary.map(normalizeDiaryEntry).filter(Boolean).slice(-MAX_DIARY_ENTRIES) : [];
  user.bookings = Array.isArray(raw.bookings) ? raw.bookings.map(normalizeBooking).filter(Boolean).slice(-MAX_BOOKINGS_PER_USER) : [];
  user.dailyMood = normalizeDailyMood(raw.dailyMood);
  user.moodSummaryAt = isoOrNull(raw.moodSummaryAt);
  user.trialNoticeAt = isoOrNull(raw.trialNoticeAt);
  user.returnedCounted = raw.returnedCounted === true;
  return user;
}

export class Store {
  // `file` is null for a memory-only run.
  constructor(options = {}) {
    this.file = options.file ? resolve(options.file) : null;
    this.writeDelayMs = options.writeDelayMs === undefined ? 1000 : Number(options.writeDelayMs);
    this.users = new Map();
    this.offset = 0;
    // Bot-wide state that belongs to no single user.
    this.meta = { adminChatId: null, funnel: {} };
    this.dirty = false;
    this.timer = null;
    // Both limits are injectable so the ceiling behaviour is testable without
    // materializing a quarter of a gigabyte.
    this.maxSnapshotBytes = options.maxSnapshotBytes === undefined
      ? MAX_SNAPSHOT_BYTES
      : Number(options.maxSnapshotBytes);
    this.warnSnapshotBytes = options.warnSnapshotBytes === undefined
      ? SNAPSHOT_WARN_BYTES
      : Number(options.warnSnapshotBytes);
    this.warnedAboutSize = false;
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
    this.onWarning = typeof options.onWarning === "function" ? options.onWarning : () => {};
  }

  load() {
    if (!this.file) return { loaded: false, reason: "memory-only" };
    // Size is checked on the file, not on a string already in memory, so an
    // oversized snapshot is refused without being read first.
    try {
      const size = statSync(this.file).size;
      if (size > this.maxSnapshotBytes) {
        throw new Error("snapshot is " + size + " bytes, over the " + this.maxSnapshotBytes + " byte ceiling");
      }
    } catch (error) {
      if (error && error.code === "ENOENT") return { loaded: false, reason: "no snapshot yet" };
      throw error;
    }
    let text = null;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return { loaded: false, reason: "no snapshot yet" };
      throw error;
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("snapshot root must be an object");
    }
    this.offset = Number.isFinite(parsed.offset) ? Number(parsed.offset) : 0;
    const meta = parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {};
    this.meta = {
      adminChatId: Number.isInteger(meta.adminChatId) ? meta.adminChatId : null,
      funnel: normalizeFunnel(meta.funnel),
    };
    const users = parsed.users && typeof parsed.users === "object" ? parsed.users : {};
    Object.keys(users).forEach((key) => {
      const chatId = Number(key);
      if (!Number.isFinite(chatId)) return;
      this.users.set(chatId, normalizeUser(chatId, users[key]));
    });
    return { loaded: true, users: this.users.size };
  }

  user(chatId) {
    const key = Number(chatId);
    let found = this.users.get(key);
    if (!found) {
      found = defaultUser(key);
      this.users.set(key, found);
      this.touch();
    }
    return found;
  }

  hasUser(chatId) {
    return this.users.has(Number(chatId));
  }

  allUsers() {
    return Array.from(this.users.values());
  }

  setMeta(patch) {
    Object.assign(this.meta, patch);
    this.touch();
    return this.meta;
  }

  // One more event of a funnel step on a local day ("YYYY-MM-DD"). Days older
  // than FUNNEL_KEEP_DAYS before it are dropped on the way.
  countFunnel(day, step) {
    if (!DATE_KEY.test(day) || FUNNEL_STEPS.indexOf(step) === -1) return;
    const funnel = this.meta.funnel || (this.meta.funnel = {});
    const counts = funnel[day] || (funnel[day] = {});
    counts[step] = (counts[step] || 0) + 1;
    const oldest = new Date(Date.parse(day + "T00:00:00Z") - FUNNEL_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    Object.keys(funnel).forEach((key) => { if (key < oldest) delete funnel[key]; });
    this.touch();
  }

  setOffset(offset) {
    const next = Number(offset);
    if (!Number.isFinite(next) || next <= this.offset) return;
    this.offset = next;
    this.touch();
  }

  // Returns the stored object so a caller can annotate it later.
  addResult(chatId, result) {
    const user = this.user(chatId);
    user.results.push(result);
    if (user.results.length > MAX_RESULTS_PER_USER) {
      user.results.splice(0, user.results.length - MAX_RESULTS_PER_USER);
    }
    this.touch();
    return result;
  }

  // Attaches the free-text weekly note to an already stored result. The result
  // must still be in this user's history: trimming or /delete in between means
  // there is nothing to annotate, and the note is dropped rather than revived.
  annotateResult(chatId, result, note) {
    if (!this.users.has(Number(chatId))) return null;
    const user = this.user(chatId);
    if (user.results.indexOf(result) === -1) return null;
    const text = String(note === null || note === undefined ? "" : note).trim();
    if (!text) {
      delete result.note;
    } else {
      result.note = text.length > MAX_NOTE_LENGTH ? text.slice(0, MAX_NOTE_LENGTH) : text;
    }
    this.touch();
    return result;
  }

  // Newest first, optionally narrowed to one instrument.
  history(chatId, instrumentId = null, limit = Infinity) {
    if (!this.users.has(Number(chatId))) return [];
    const results = this.user(chatId).results;
    const matching = instrumentId ? results.filter((entry) => entry.instrument === instrumentId) : results;
    const reversed = matching.slice().reverse();
    return limit === Infinity ? reversed : reversed.slice(0, limit);
  }

  // Oldest first.
  moods(chatId) {
    if (!this.users.has(Number(chatId))) return [];
    return this.user(chatId).moods.slice();
  }

  moodOn(chatId, date) {
    if (!this.users.has(Number(chatId))) return null;
    return this.user(chatId).moods.find((entry) => entry.date === date) || null;
  }

  // A second check-in on the same local day replaces the first, keeping its
  // tags, so a misclick can be corrected without a second row.
  setMood(chatId, entry) {
    const mood = normalizeMood(entry);
    if (!mood) return null;
    const user = this.user(chatId);
    const existing = user.moods.find((candidate) => candidate.date === mood.date);
    if (existing) {
      existing.rating = mood.rating;
      existing.at = mood.at;
      if (Array.isArray(entry.tags)) existing.tags = mood.tags;
      this.touch();
      return existing;
    }
    user.moods.push(mood);
    user.moods.sort((left, right) => (left.date < right.date ? -1 : 1));
    if (user.moods.length > MAX_MOODS_PER_USER) user.moods.splice(0, user.moods.length - MAX_MOODS_PER_USER);
    this.touch();
    return mood;
  }

  toggleMoodTag(chatId, date, tagId) {
    const entry = this.moodOn(chatId, date);
    if (!entry || !moodTag(tagId)) return null;
    const at = entry.tags.indexOf(tagId);
    if (at === -1) entry.tags.push(tagId);
    else entry.tags.splice(at, 1);
    this.touch();
    return entry;
  }

  lastResult(chatId, instrumentId) {
    const recent = this.history(chatId, instrumentId, 1);
    return recent.length ? recent[0] : null;
  }

  updateUser(chatId, patch) {
    const user = this.user(chatId);
    Object.assign(user, patch);
    this.touch();
    return user;
  }

  forget(chatId) {
    const existed = this.users.delete(Number(chatId));
    if (existed) this.touch();
    return existed;
  }

  touch() {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch (error) {
        this.onError(error);
      }
    }, this.writeDelayMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  snapshot() {
    const users = {};
    this.users.forEach((user, chatId) => {
      users[String(chatId)] = user;
    });
    return { version: SNAPSHOT_VERSION, savedAt: new Date().toISOString(), offset: this.offset, meta: this.meta, users };
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.file || !this.dirty) return false;
    // Compact rather than indented: the snapshot is written and read by this
    // process only, and indentation costs slightly over twice the bytes and
    // serialization time. `/export` still shows the user indented JSON.
    const body = JSON.stringify(this.snapshot()) + "\n";
    const size = Buffer.byteLength(body, "utf8");
    if (size > this.maxSnapshotBytes) {
      throw new Error("snapshot would be " + size + " bytes, over the " + this.maxSnapshotBytes +
        " byte ceiling. Lower MAX_RESULTS_PER_USER or move storage to a database.");
    }
    if (size > this.warnSnapshotBytes && !this.warnedAboutSize) {
      this.warnedAboutSize = true;
      this.onWarning("snapshot has reached " + Math.round(size / 1024 / 1024) + " MB: each flush now " +
        "serializes the whole file and blocks the event loop. Consider a database.");
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp-" + process.pid;
    let fd = null;
    try {
      fd = openSync(temporary, "w", 0o600);
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      if (fd !== null) closeSync(fd);
    }
    try {
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch (cleanupError) {
        if (!cleanupError || cleanupError.code !== "ENOENT") this.onError(cleanupError);
      }
      throw error;
    }
    this.dirty = false;
    return true;
  }
}
