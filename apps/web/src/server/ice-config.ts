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
 * One-shot startup warning for the half-set TURN misconfiguration. `buildIceServers`
 * silently omits a TURN entry when only one of the URL/secret pair is set; without
 * this the operator gets no signal that their relay is dark. Module-scope so it
 * fires exactly once at import, gated on the env module's `SKIP_ENV_VALIDATION`
 * escape hatch so tests do not spam warnings. Does NOT throw — the route keeps
 * serving a degraded (STUN-only) list either way; this is operator visibility,
 * not enforcement. Read from `process.env` directly (rather than the already-built
 * `env` snapshot) so the check is independent of env-core's eager parse order.
 */
if (!process.env.SKIP_ENV_VALIDATION) {
  const hasTurnUrl = process.env.TURN_URL !== undefined && process.env.TURN_URL !== "";
  const hasTurnTlsUrl = process.env.TURN_TLS_URL !== undefined && process.env.TURN_TLS_URL !== "";
  const hasTurnSecret =
    process.env.TURN_SHARED_SECRET !== undefined && process.env.TURN_SHARED_SECRET !== "";
  if ((hasTurnUrl || hasTurnTlsUrl) && !hasTurnSecret) {
    console.warn(
      "[ice-config] TURN_URL/TURN_TLS_URL is set but TURN_SHARED_SECRET is missing — TURN relay disabled. Set both or neither.",
    );
  } else if (hasTurnSecret && !hasTurnUrl && !hasTurnTlsUrl) {
    console.warn(
      "[ice-config] TURN_SHARED_SECRET is set but neither TURN_URL nor TURN_TLS_URL is configured — TURN relay disabled. Set both or neither.",
    );
  }
}

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
  const credential = createHmac("sha1", secret).update(username).digest("base64");
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
 *
 * `PUBLIC_BASE_URL` is included even though {@link buildIceServers} does not
 * consume it: the route returns it alongside `iceServers` (see
 * {@link IceConfigResponse}) so the SPA can format invitation links from a
 * RUNTIME server value rather than a build-time bake. Keeping it in
 * {@link IceEnv} lets the pure-helper test surface (which calls
 * `buildIceServers` with an `IceEnv` literal) assert that the field is
 * propagated correctly without standing up the dev server.
 */
export interface IceEnv {
  readonly STUN_URL?: string;
  readonly TURN_URL?: string;
  readonly TURN_TLS_URL?: string;
  readonly TURN_SHARED_SECRET?: string;
  readonly PUBLIC_BASE_URL?: string;
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
    const { username, credential } = mintTurnCredentials(iceEnv.TURN_SHARED_SECRET, now);
    iceServers.push({
      urls: iceEnv.TURN_URL,
      username,
      credential,
    });
  }

  if (iceEnv.TURN_TLS_URL !== undefined && iceEnv.TURN_SHARED_SECRET !== undefined) {
    const { username, credential } = mintTurnCredentials(iceEnv.TURN_SHARED_SECRET, now);
    iceServers.push({
      urls: iceEnv.TURN_TLS_URL,
      username,
      credential,
    });
  }

  return iceServers;
}

/**
 * Shape of the GET /ice-config response. The `iceServers` field is the primary
 * payload (Phase 0); `publicBaseUrl` (MEDIUM-E) carries the RUNTIME
 * server-side public web origin the SPA should use as the prefix of every
 * generated invitation link. Optional: when the server env does not configure
 * `PUBLIC_BASE_URL`, the field is `undefined` and the SPA falls back to
 * `window.location.origin`.
 *
 * `publicBaseUrl` is intentionally NOT a Cache-Control-differing field: like
 * `iceServers`, it is identical for every client (a single operator-set
 * origin), so the response stays cacheable across sessions.
 */
export interface IceConfigResponse {
  readonly iceServers: readonly RTCIceServer[];
  /**
   * Public web origin (e.g. `https://chat.example.com`) the SPA should use as
   * the invitation-link prefix. `undefined` when the operator has not
   * configured `PUBLIC_BASE_URL`; the SPA translates that to
   * `window.location.origin`.
   */
  readonly publicBaseUrl?: string;
}

/**
 * GET /ice-config → {@link IceConfigResponse}.
 *
 * See module docstring. The `Cache-Control` max-age is shorter than the minted
 * credential TTL so a cached response is always still valid when the client
 * uses it (and the browser pulls a fresh credential pair on the next session).
 */
export default defineEventHandler((event): IceConfigResponse => {
  const now = Math.floor(Date.now() / 1000);
  const iceServers = buildIceServers(env, now);
  // public: the response is identical for every client (no per-user state —
  // the username carries a constant id, not an identity). This lets the
  // browser AND any shared CDN edge cache it for the TTL below. With no CDN
  // this degrades to a normal fetch cache.
  setHeader(event, "Cache-Control", `public, max-age=${CACHE_MAX_AGE_SECONDS}`);
  // MEDIUM-E (Dokploy fix): surface the runtime PUBLIC_BASE_URL so the SPA
  // formats invitation links from a server-injected value instead of a
  // build-time bake. Conditionally spread so the field is ABSENT (not
  // `undefined` in JSON) when unset — both consumers (web + mobile) treat
  // absence and empty identically, but omitting keeps the response body clean
  // for the cache-key-normalizing proxies that distinguish key sets.
  return {
    iceServers,
    ...(env.PUBLIC_BASE_URL !== undefined ? { publicBaseUrl: env.PUBLIC_BASE_URL } : {}),
  };
});
