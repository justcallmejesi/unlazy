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

export const MAX_RESULTS_PER_USER = 200;
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
    results: [],
  };
}

function normalizeUser(chatId, raw) {
  const user = defaultUser(chatId);
  if (!raw || typeof raw !== "object") return user;
  user.firstSeenAt = typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : null;
  user.remindersEnabled = raw.remindersEnabled !== false;
  user.reminderTime = typeof raw.reminderTime === "string" ? raw.reminderTime : null;
  user.tzOffsetMinutes = Number.isInteger(raw.tzOffsetMinutes) ? raw.tzOffsetMinutes : null;
  user.lastRemindedAt = Number.isFinite(raw.lastRemindedAt) ? Number(raw.lastRemindedAt) : 0;
  // A result without an instrument id or a numeric score cannot be displayed
  // or compared, so it is dropped rather than rendered as "undefined".
  user.results = Array.isArray(raw.results)
    ? raw.results.filter((entry) => entry && typeof entry === "object" &&
      typeof entry.instrument === "string" && Number.isFinite(entry.score))
    : [];
  return user;
}

export class Store {
  // `file` is null for a memory-only run.
  constructor(options = {}) {
    this.file = options.file ? resolve(options.file) : null;
    this.writeDelayMs = options.writeDelayMs === undefined ? 1000 : Number(options.writeDelayMs);
    this.users = new Map();
    this.offset = 0;
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

  setOffset(offset) {
    const next = Number(offset);
    if (!Number.isFinite(next) || next <= this.offset) return;
    this.offset = next;
    this.touch();
  }

  addResult(chatId, result) {
    const user = this.user(chatId);
    user.results.push(result);
    if (user.results.length > MAX_RESULTS_PER_USER) {
      user.results.splice(0, user.results.length - MAX_RESULTS_PER_USER);
    }
    this.touch();
    return user.results.length;
  }

  // Newest first, optionally narrowed to one instrument.
  history(chatId, instrumentId = null, limit = Infinity) {
    if (!this.users.has(Number(chatId))) return [];
    const results = this.user(chatId).results;
    const matching = instrumentId ? results.filter((entry) => entry.instrument === instrumentId) : results;
    const reversed = matching.slice().reverse();
    return limit === Infinity ? reversed : reversed.slice(0, limit);
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
    return { version: SNAPSHOT_VERSION, savedAt: new Date().toISOString(), offset: this.offset, users };
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
