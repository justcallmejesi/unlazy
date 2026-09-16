// In-memory store for users, questionnaire results, and reminder state, with an
// optional durable JSON snapshot. Zero dependencies. Node 16+.
//
// Every read and write goes to the in-memory maps, so the bot never waits on
// disk while a questionnaire is in progress. Snapshots are debounced and
// written atomically (temporary file, fsync, rename) so a crash mid-write
// cannot truncate an existing snapshot.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const MAX_RESULTS_PER_USER = 200;
const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

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
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
  }

  load() {
    if (!this.file) return { loaded: false, reason: "memory-only" };
    let text = null;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return { loaded: false, reason: "no snapshot yet" };
      throw error;
    }
    if (text.length > MAX_SNAPSHOT_BYTES) throw new Error("snapshot exceeds " + MAX_SNAPSHOT_BYTES + " bytes");
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
    const body = JSON.stringify(this.snapshot(), null, 2) + "\n";
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
