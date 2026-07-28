/**
 * Phase 0: ICE config endpoint.
 *
 * Serves the browser the list of WebRTC ICE servers it should pass to
 * `RTCPeerConnection`. STUN/TURN/TURNS endpoints come from the server env
 * (`STUN_URL`, `TURN_URL`, `TURN_TLS_URL`). For TURN/TURN-TLS we mint a
 * fresh HMAC-SHA1 long-term credential pair per request, using the
 * TURN REST API format (a.k.a. "time-limited credentials"):
 *
 *   username  = "<unix-expiry-seconds>:<id>"
 *   credential = base64( HMAC-SHA1(secret, username) )
 *
 * The shared secret (`env.TURN_SHARED_SECRET`) NEVER leaves this handler —
 * only the resulting ephemeral `username`/`credential` are sent to the client,
 * and they expire after `TURN_CREDENTIAL_TTL_SECONDS`. Consistent with the
 * deployment guide §8 ("runtime config contains only public endpoint details").
 *
 * When nothing is configured (loopback / LAN / CI), the response is
 * `{ iceServers: [] }` — the client's P2P stack gathers host candidates only,
 * which is what makes `localhost`-to-`localhost` connections work without any
 * STUN/TURN infra.
 */
import { createHmac } from "node:crypto";

import { defineEventHandler, setHeader } from "nitro/h3";

import { env } from "@fuck-eu-chat-control/env/server";

/**
 * Label embedded in the TURN REST API username. The spec is
 * `"<expiry>:<arbitrary-id>"`; the id is opaque to coturn and only surfaces in
 * its allocation logs. Using a constant here keeps the per-username entropy in
 * the expiry (which is driven by the request clock), avoids embedding any kind
 * of device/session identifier (which would leak into TURN logs), and matches
 * the deployment guide's "no identity material leaves the client" stance.
 */
const TURN_USERNAME_ID = "fck-web";

/**
 * How long a minted credential is valid. coturn enforces this server-side by
 * comparing the expiry prefix against its own clock, so the client MUST have
 * refreshed by then. 6 hours (21600s) covers a typical browser session without
 * forcing a re-fetch on every page navigation — `/ice-config` sets a Cache-
 * Control max-age well below this (see {@link CACHE_MAX_AGE_SECONDS}) so the
 * browser re-fetches comfortably before the credential lapses.
 */
const TURN_CREDENTIAL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Response `Cache-Control` max-age. Kept shorter than the credential TTL so a
 * cached response is always still valid when the client uses it, and so the
 * browser pulls a fresh credential pair on the next session without waiting
 * for the full TTL. 1 hour (3600s) vs. a 6-hour TTL gives a 5-hour validity
 * margin — ample headroom for clock skew between client and coturn.
 */
const CACHE_MAX_AGE_SECONDS = 60 * 60;

/**
 * Pure credential minter, exported so the unit suite can assert the
 * HMAC-SHA1 format directly without spinning up the dev server. Mirrors the
 * `origin-guard.ts` extraction pattern.
 *
 * @param secret  The coturn `static-auth-secret` (server-held).
 * @param now     Unix seconds — the issuance time. Passed in so tests can pin
 *                the expiry deterministically.
 * @param ttlSec  Credential lifetime in seconds.
 * @returns `{ username, credential }` matching the TURN REST API.
 */
export function mintTurnCredentials(
  secret: string,
  now: number,
  ttlSec: number = TURN_CREDENTIAL_TTL_SECONDS,
): { readonly username: string; readonly credential: string } {
  const expiry = now + ttlSec;
  const username = `${expiry}:${TURN_USERNAME_ID}`;
  const credential = createHmac("sha1", secret)
    .update(username)
    .digest("base64");
  return { username, credential };
}

/**
 * The subset of the server env that drives ICE config. Extracted as a type so
 * {@link buildIceServers} is a pure function of `(env, now)` — the route
 * passes the real `env`, the unit suite passes a literal. This is what makes
 * the credential-minting + composition testable without standing up the dev
 * server or fighting env-core's eager snapshot (see packages/env/src/server.ts:
 * `createEnv` parses `process.env` once at import time, so `vi.stubEnv` after
 * import has no effect on the already-built env object).
 */
export interface IceEnv {
  readonly STUN_URL?: string;
  readonly TURN_URL?: string;
  readonly TURN_TLS_URL?: string;
  readonly TURN_SHARED_SECRET?: string;
}

/**
 * Build the `RTCIceServer[]` for a request. Pure (env-in, value-out) so it is
 * unit-testable; the handler is a thin wrapper that calls this and stamps HTTP
 * metadata. The shape matches the `RTCIceServer` WebIDL: `urls` is a string or
 * string[], `username`/`credential` are present iff the server needs auth
 * (STUN never does; TURN/TURN-TLS do).
 */
export function buildIceServers(iceEnv: IceEnv, now: number): readonly RTCIceServer[] {
  const iceServers: RTCIceServer[] = [];

  if (iceEnv.STUN_URL !== undefined) {
    iceServers.push({ urls: iceEnv.STUN_URL });
  }

  // TURN credentials are only meaningful when both a relay URL and the shared
  // secret are configured. Missing either is a configuration error we surface
  // by OMITTING the entry (returning a degraded list) rather than throwing —
  // a partial misconfiguration must not take chat down for everyone.
  if (iceEnv.TURN_URL !== undefined && iceEnv.TURN_SHARED_SECRET !== undefined) {
    const { username, credential } = mintTurnCredentials(
      iceEnv.TURN_SHARED_SECRET,
      now,
    );
    iceServers.push({
      urls: iceEnv.TURN_URL,
      username,
      credential,
    });
  }

  if (
    iceEnv.TURN_TLS_URL !== undefined &&
    iceEnv.TURN_SHARED_SECRET !== undefined
  ) {
    const { username, credential } = mintTurnCredentials(
      iceEnv.TURN_SHARED_SECRET,
      now,
    );
    iceServers.push({
      urls: iceEnv.TURN_TLS_URL,
      username,
      credential,
    });
  }

  return iceServers;
}

/**
 * GET /ice-config → `{ iceServers: RTCIceServer[] }`.
 *
 * See module docstring. The `Cache-Control` max-age is shorter than the minted
 * credential TTL so a cached response is always still valid when the client
 * uses it (and the browser pulls a fresh credential pair on the next session).
 */
export default defineEventHandler((event): {
  readonly iceServers: readonly RTCIceServer[];
} => {
  const now = Math.floor(Date.now() / 1000);
  const iceServers = buildIceServers(env, now);
  // public: the response is identical for every client (no per-user state —
  // the username carries a constant id, not an identity). This lets the
  // browser AND any shared CDN edge cache it for the TTL below. With no CDN
  // this degrades to a normal fetch cache.
  setHeader(
    event,
    "Cache-Control",
    `public, max-age=${CACHE_MAX_AGE_SECONDS}`,
  );
  return { iceServers };
});
