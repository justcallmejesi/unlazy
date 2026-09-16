// Active questionnaire sessions. Zero dependencies. Node 16+.
//
// Sessions live only in memory: an interrupted run is restarted rather than
// resumed, so a partially answered questionnaire can never be scored. Session
// ids are short because they travel inside Telegram's 64-byte callback_data.

const SESSION_ID_RADIX = 36;

export class SessionManager {
  constructor(options = {}) {
    this.byChat = new Map();
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

  size() {
    return this.byChat.size;
  }
}
