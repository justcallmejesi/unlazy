// Minimal Telegram Bot API client over the Node standard library.
// Zero dependencies. Node 16+ (no global fetch required).
//
// The bot token is a credential: it is never placed in a log line, an error
// message, or a thrown stack. Every outgoing string is scrubbed through
// `redact` before it can reach a caller.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export const DEFAULT_API_BASE = "https://api.telegram.org";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class TelegramError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TelegramError";
    this.status = details.status === undefined ? null : details.status;
    this.errorCode = details.errorCode === undefined ? null : details.errorCode;
    this.retryAfterMs = details.retryAfterMs === undefined ? null : details.retryAfterMs;
    this.fatal = Boolean(details.fatal);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export class TelegramClient {
  constructor(options = {}) {
    this.token = String(options.token || "");
    if (!this.token) throw new Error("TelegramClient needs a bot token");
    this.apiBase = String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs === undefined ? 30000 : Number(options.requestTimeoutMs);
    this.maxAttempts = options.maxAttempts === undefined ? 4 : Number(options.maxAttempts);
    this.log = typeof options.log === "function" ? options.log : () => {};
  }

  // Replace the token anywhere it could appear in a message or URL.
  redact(text) {
    return String(text).split(this.token).join("<token>");
  }

  async call(method, payload = {}, options = {}) {
    const attempts = options.maxAttempts === undefined ? this.maxAttempts : Number(options.maxAttempts);
    const timeoutMs = options.timeoutMs === undefined ? this.requestTimeoutMs : Number(options.timeoutMs);
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
      try {
        return await this.send(method, payload, timeoutMs);
      } catch (error) {
        lastError = error;
        if (error instanceof TelegramError && error.fatal) throw error;
        if (attempt >= Math.max(1, attempts)) break;
        const backoff = error instanceof TelegramError && error.retryAfterMs !== null
          ? error.retryAfterMs
          : Math.min(16000, 1000 * Math.pow(2, attempt - 1));
        this.log("retry " + method + " in " + backoff + "ms: " + this.redact(error.message));
        await sleep(backoff);
      }
    }
    throw lastError;
  }

  send(method, payload, timeoutMs) {
    const url = new URL(this.apiBase + "/bot" + this.token + "/" + method);
    const body = Buffer.from(JSON.stringify(payload === undefined ? {} : payload), "utf8");
    const transport = url.protocol === "http:" ? httpRequest : httpsRequest;
    return new Promise((resolve, reject) => {
      const outgoing = transport(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "http:" ? 80 : 443),
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            "accept": "application/json",
          },
        },
        (response) => {
          const chunks = [];
          let size = 0;
          let aborted = false;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              aborted = true;
              response.destroy();
              reject(new TelegramError(method + " response exceeded " + MAX_RESPONSE_BYTES + " bytes"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (aborted) return;
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch (error) {
              reject(new TelegramError(method + " returned invalid JSON (status " + response.statusCode + ")", {
                status: response.statusCode,
              }));
              return;
            }
            if (parsed && parsed.ok === true) {
              resolve(parsed.result);
              return;
            }
            const status = response.statusCode;
            const description = this.redact((parsed && parsed.description) || "no description");
            const retryAfterSeconds = parsed && parsed.parameters && Number(parsed.parameters.retry_after);
            // 429 is a rate limit and 409 is a second poller that is about to
            // stop, so both are worth a backed-off retry, as is any 5xx. Every
            // other 4xx describes a request that cannot succeed as written.
            const retryable = status === 429 || status === 409 || status === undefined || status >= 500;
            reject(new TelegramError(method + " failed with " + status + ": " + description, {
              status,
              errorCode: parsed && parsed.error_code,
              retryAfterMs: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : null,
              fatal: !retryable,
            }));
          });
        },
      );
      outgoing.setTimeout(Math.max(1000, timeoutMs), () => {
        outgoing.destroy(new TelegramError(method + " timed out after " + timeoutMs + "ms"));
      });
      outgoing.on("error", (error) => {
        reject(error instanceof TelegramError
          ? error
          : new TelegramError(method + " transport error: " + this.redact(error.message)));
      });
      outgoing.end(body);
    });
  }

  getMe() {
    return this.call("getMe");
  }

  // Long polling. The socket timeout must outlive the server-side wait.
  getUpdates(options = {}) {
    const timeoutSeconds = options.timeoutSeconds === undefined ? 50 : Number(options.timeoutSeconds);
    return this.call(
      "getUpdates",
      {
        offset: options.offset,
        timeout: timeoutSeconds,
        limit: options.limit === undefined ? 100 : Number(options.limit),
        allowed_updates: options.allowedUpdates || ["message", "callback_query"],
      },
      { timeoutMs: (timeoutSeconds + 20) * 1000, maxAttempts: 1 },
    );
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", Object.assign({ chat_id: chatId, text }, extra));
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call("editMessageText", Object.assign({ chat_id: chatId, message_id: messageId, text }, extra));
  }

  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  answerCallbackQuery(callbackQueryId, extra = {}) {
    return this.call("answerCallbackQuery", Object.assign({ callback_query_id: callbackQueryId }, extra));
  }

  setMyCommands(commands) {
    return this.call("setMyCommands", { commands });
  }
}

export function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
