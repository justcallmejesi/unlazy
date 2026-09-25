// Active questionnaire sessions and pending weekly notes. Zero dependencies.
// Node 16+.
//
// Sessions live only in memory: an interrupted run is restarted rather than
// resumed, so a partially answered questionnaire can never be scored. Session
// ids are short because they travel inside Telegram's 64-byte callback_data.
//
// A pending note is the state after the last question: the result is already
// scored and stored, and the next free-text message is attached to it. Losing
// this state to a restart costs the note, never the result.

const SESSION_ID_RADIX = 36;

export class SessionManager {
  constructor(options = {}) {
    this.byChat = new Map();
    this.notesByChat = new Map();
    this.bookingsByChat = new Map();
    this.applicationsByChat = new Map();
    this.counter = 0;
    this.idleTimeoutMs = options.idleTimeoutMs === undefined ? 60 * 60 * 1000 : Number(options.idleTimeoutMs);
  }

  nextId() {
    this.counter += 1;
    return this.counter.toString(SESSION_ID_RADIX) + Math.floor(Math.random() * 1296).toString(SESSION_ID_RADIX);
  }

  start(chatId, instrument, nowMs) {
    const session = {
      id: this.nextId(),
      chatId: Number(chatId),
      instrumentId: instrument.id,
      total: instrument.items.length,
      index: 0,
      answers: [],
      startedAt: nowMs,
      updatedAt: nowMs,
      messageId: null,
    };
    this.byChat.set(session.chatId, session);
    return session;
  }

  get(chatId, nowMs) {
    const session = this.byChat.get(Number(chatId));
    if (!session) return null;
    if (nowMs !== undefined && this.idleTimeoutMs > 0 && nowMs - session.updatedAt > this.idleTimeoutMs) {
      this.byChat.delete(session.chatId);
      return null;
    }
    return session;
  }

  cancel(chatId) {
    return this.byChat.delete(Number(chatId));
  }

  bindMessage(chatId, messageId) {
    const session = this.byChat.get(Number(chatId));
    if (session) session.messageId = messageId;
    return session;
  }

  // `expect` is optional; when present it must match the live session and its
  // current item, which is how repeated taps on an older question are ignored.
  answer(chatId, value, expect, nowMs) {
    const session = this.get(chatId, nowMs);
    if (!session) return { status: "none", session: null };
    if (expect) {
      if (expect.sessionId !== session.id) return { status: "stale", session };
      if (Number(expect.itemIndex) !== session.index) return { status: "stale", session };
    }
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) return { status: "invalid", session };
    session.answers.push(numeric);
    session.index += 1;
    session.updatedAt = nowMs === undefined ? Date.now() : nowMs;
    const done = session.index >= session.total;
    if (done) this.byChat.delete(session.chatId);
    return { status: "recorded", session, done };
  }

  // `result` is the object the store returned, so the note can be attached to
  // exactly that entry even after further runs.
  expectNote(chatId, instrumentId, result, nowMs) {
    const pending = {
      id: this.nextId(),
      chatId: Number(chatId),
      instrumentId,
      result,
      askedAt: nowMs === undefined ? Date.now() : nowMs,
    };
    this.notesByChat.set(pending.chatId, pending);
    return pending;
  }

  pendingNote(chatId, nowMs) {
    const pending = this.notesByChat.get(Number(chatId));
    if (!pending) return null;
    if (nowMs !== undefined && this.idleTimeoutMs > 0 && nowMs - pending.askedAt > this.idleTimeoutMs) {
      this.notesByChat.delete(pending.chatId);
      return null;
    }
    return pending;
  }

  clearNote(chatId) {
    return this.notesByChat.delete(Number(chatId));
  }

  size() {
    return this.byChat.size;
  }

  pendingNoteCount() {
    return this.notesByChat.size;
  }

  // A consultation request in progress: format, time, a free-text request
  // and whether to include the latest scores. Memory only, like everything
  // here; a restart just means answering four quick questions again.
  startBooking(chatId, nowMs) {
    const booking = {
      chatId: Number(chatId),
      step: "format",
      format: null,
      time: null,
      request: null,
      updatedAt: nowMs === undefined ? Date.now() : nowMs,
    };
    this.bookingsByChat.set(booking.chatId, booking);
    return booking;
  }

  booking(chatId, nowMs) {
    const booking = this.bookingsByChat.get(Number(chatId));
    if (!booking) return null;
    if (nowMs !== undefined && this.idleTimeoutMs > 0 && nowMs - booking.updatedAt > this.idleTimeoutMs) {
      this.bookingsByChat.delete(booking.chatId);
      return null;
    }
    return booking;
  }

  updateBooking(chatId, patch, nowMs) {
    const booking = this.booking(chatId, nowMs);
    if (!booking) return null;
    Object.assign(booking, patch, { updatedAt: nowMs === undefined ? Date.now() : nowMs });
    return booking;
  }

  clearBooking(chatId) {
    return this.bookingsByChat.delete(Number(chatId));
  }

  pendingBookingCount() {
    return this.bookingsByChat.size;
  }

  // A specialist's application in progress: name, then credentials, then the
  // terms. Memory only; an interrupted application just starts again.
  startApplication(chatId, nowMs) {
    const application = { chatId: Number(chatId), step: "name", name: null, credentials: null,
      updatedAt: nowMs === undefined ? Date.now() : nowMs };
    this.applicationsByChat.set(application.chatId, application);
    return application;
  }

  application(chatId, nowMs) {
    const application = this.applicationsByChat.get(Number(chatId));
    if (!application) return null;
    if (nowMs !== undefined && this.idleTimeoutMs > 0 && nowMs - application.updatedAt > this.idleTimeoutMs) {
      this.applicationsByChat.delete(application.chatId);
      return null;
    }
    return application;
  }

  updateApplication(chatId, patch, nowMs) {
    const application = this.application(chatId, nowMs);
    if (!application) return null;
    Object.assign(application, patch, { updatedAt: nowMs === undefined ? Date.now() : nowMs });
    return application;
  }

  clearApplication(chatId) {
    return this.applicationsByChat.delete(Number(chatId));
  }
}
