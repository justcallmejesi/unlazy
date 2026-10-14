// Liveness: the bot restarts itself when polling stalls, and pings an outside
// monitor while it is healthy. Zero dependencies, Node 16+.
//
// systemd's Restart=always only covers a process that exits. A poll that hangs
// forever leaves a live process that answers nobody, so the ticker checks how
// long ago the last poll came back and exits once that is too long; systemd
// then starts a fresh one. A server that is switched off or suspended cannot
// report itself, so HEARTBEAT_URL lets a monitor such as Healthchecks.io notice
// the pings stopping and send the alert from outside.

import { request as httpsRequest } from "node:https";

// A long poll returns within POLL_TIMEOUT_SECONDS, 50 by default, so ten
// minutes without one is a hang, not a slow network.
export const STALL_MS = 10 * 60 * 1000;
export const HEARTBEAT_EVERY_MS = 5 * 60 * 1000;

export function stalled(lastPollOkMs, nowMs) {
  return nowMs - lastPollOkMs > STALL_MS;
}

// Ping only while polling works: a process that cannot reach Telegram should
// look dead to the monitor too.
export function heartbeatDue(state, nowMs) {
  if (!state.url) return false;
  if (nowMs - state.lastPollOkMs > 3 * 60 * 1000) return false;
  return !state.lastPingMs || nowMs - state.lastPingMs >= HEARTBEAT_EVERY_MS;
}

export function ping(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300
        ? resolve(res.statusCode)
        : reject(new Error("heartbeat answered " + res.statusCode))));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("heartbeat timed out")));
    req.on("error", reject);
    req.end();
  });
}
