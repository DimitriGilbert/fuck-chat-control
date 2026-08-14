/**
 * GET /healthz — dedicated container healthcheck route (R7:F5).
 *
 * The docker-compose `web` healthcheck previously probed `/` (the prerendered
 * SPA shell), which a static-asset server can answer while the credential-
 * minting route is broken. This route instead exercises the pieces a chat
 * client actually depends on at boot:
 *
 *  - the process is serving HTTP (implicit — the route answered), and
 *  - the TURN configuration is SELF-CONSISTENT: a half-configured TURN setup
 *    (URL without shared secret, or secret without URL) makes /ice-config
 *    silently serve a degraded STUN-only list, which is exactly the prod
 *    failure that used to hide behind a green healthcheck.
 *
 * A deployment that intentionally runs without TURN (loopback / LAN) stays
 * healthy: "no TURN at all" is consistent; only a HALF configuration fails.
 *
 * The route also mints one throwaway TURN credential (when a secret is
 * configured) so the HMAC path is exercised on every probe — a broken node
 * crypto runtime fails the healthcheck rather than every client silently.
 *
 * Deliberately NOT checked: the broker WebSocket (same process, same event
 * loop — if /healthz answers, the loop is alive; a WS-specific probe would
 * need an upgrade handshake and adds flakiness for no signal) and coturn
 * itself (a separate container with its own healthcheck).
 */
import { defineEventHandler, setResponseStatus } from "nitro/h3";

import { env } from "@fuck-eu-chat-control/env/server";

import { mintTurnCredentials } from "./ice-config";

export interface HealthzResponse {
  readonly ok: boolean;
  /** Machine-readable reason when `ok` is false. */
  readonly reason?: string;
}

export default defineEventHandler((event): HealthzResponse => {
  const hasTurnUrl = env.TURN_URL !== undefined || env.TURN_TLS_URL !== undefined;
  const hasTurnSecret = env.TURN_SHARED_SECRET !== undefined;

  if (hasTurnUrl !== hasTurnSecret) {
    setResponseStatus(event, 503);
    return {
      ok: false,
      reason: hasTurnUrl
        ? "TURN_URL/TURN_TLS_URL is set but TURN_SHARED_SECRET is missing — /ice-config is serving a degraded STUN-only list"
        : "TURN_SHARED_SECRET is set but neither TURN_URL nor TURN_TLS_URL is configured — TURN relay is dark",
    };
  }

  if (hasTurnSecret) {
    // Exercise the credential-minting path the same way /ice-config does.
    mintTurnCredentials(env.TURN_SHARED_SECRET as string, 0, 1);
  }

  return { ok: true };
});
