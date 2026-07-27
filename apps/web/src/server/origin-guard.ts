/**
 * CR-16: WebSocket Origin guard.
 *
 * The broker is a pure signaling relay — it never sees keys or plaintext, so a
 * cross-origin WebSocket can at worst occupy a room slot (room-occupation DoS).
 * That is an availability impact, which the PRD explicitly scopes out of v1.
 * Even so, enforcing the configured `CORS_ORIGIN` closes the room-occupation
 * vector from arbitrary cross-origin tabs and removes the prior
 * "parsed-but-unused" misbelief in the env schema.
 *
 * v1 trade-off (availability-only, PRD-out-of-scope): an attacker who can open
 * a WebSocket to the broker can still attempt room occupation when no origin is
 * configured. With `CORS_ORIGIN` set, only same-origin tabs (or clients with no
 * `Origin` header, e.g. non-browser CLI clients) can connect. Browsers always
 * send `Origin` on WebSocket handshakes, so this is effective against the web
 * attack surface while staying no-op for local/dev where the var is unset.
 *
 * Extracted as a pure function so the policy is unit-testable without standing
 * up a crossws Peer (the integration suite in tests/integration/broker-ws.test.ts
 * covers the live socket path against the real dev server).
 */

/**
 * Decide whether a WebSocket upgrade's `Origin` header is allowed.
 *
 * @param allowedOrigin The configured `env.CORS_ORIGIN` (exact origin string,
 *   e.g. `https://app.example.com`), or `undefined`/empty when not configured.
 * @param requestOrigin The `Origin` header value from the upgrade request, or
 *   `null`/`undefined` when absent (non-browser clients, `ws` CLI).
 * @returns `true` when the connection should be admitted.
 */
export function isOriginAllowed(
  allowedOrigin: string | undefined,
  requestOrigin: string | null | undefined,
): boolean {
  // No configured allow-list → fail open. This is what keeps dev/preview/local
  // (where CORS_ORIGIN is never set) and non-browser clients working.
  if (allowedOrigin === undefined || allowedOrigin === "") {
    return true;
  }
  // Absent Origin (non-browser client, curl, the `ws` library without
  // `opts.origin`). We admit these: the threat model is browser cross-origin
  // tabs, which always send Origin. Rejecting headerless clients would break
  // CLI/dev tooling without buying any real protection.
  if (requestOrigin === null || requestOrigin === undefined || requestOrigin === "") {
    return true;
  }
  return requestOrigin === allowedOrigin;
}
