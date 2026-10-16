import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// R15:F3 + R9:F1: ICE endpoint URLs must carry an explicit RFC 7064/7065
// scheme. A bare `z.string()` accepted schemeless values like
// "turn.example.com:3478", which pass env validation but brick every client's
// RTCPeerConnection at ICE-gather time — the browser silently drops malformed
// iceServers entries. The regexes are anchored to the scheme; the `.+` floor
// rejects a bare scheme with no host. Per-variable scheme sets (each URL is
// emitted as its own RTCIceServer entry by apps/web/src/server/ice-config.ts):
//
//   STUN_URL      — stun:/stuns: only. STUN entries never carry credentials;
//                   a turn[s]: value here would mint a permanently-failing
//                   auth-less relay entry.
//   TURN_URL      — turn:/turns:. Both get HMAC credentials minted, so a
//                   turns: relay configured under TURN_URL still works —
//                   restricting this var to turn: would reject valid setups.
//   TURN_TLS_URL  — turns: only. The var exists specifically for the
//                   TURN-over-TLS relay (coturn's 5349 listener); a turn:
//                   value is almost certainly an operator slip that would
//                   silently duplicate TURN_URL's role while the TLS relay
//                   goes unused — fail closed instead of passing validation.
const STUN_URL_PATTERN = /^stuns?:.+/;
const TURN_URL_PATTERN = /^turns?:.+/;
const TURN_TLS_URL_PATTERN = /^turns:.+/;

// R15:F2: floor for the coturn `static-auth-secret`, matching the runtime
// guard in deploy/coturn/entrypoint.sh. /ice-config is an unauthenticated
// HMAC-SHA1 offline oracle, so a weak secret makes the credential TTL
// brute-forceable.
const TURN_SHARED_SECRET_MIN_LENGTH = 32;

export const env = createEnv({
  server: {
    // CR-16: optional so an unset var is a no-op in the broker's origin guard
    // (dev/preview/local never configure it). Enforced only when an operator
    // sets it in production — see apps/web/src/server/broker.ts.
    // R4:F3: canonicalized via `new URL(...).origin` so `https://host/`,
    // `https://host:443`, and `HTTPS://HOST` all fold to `https://host` —
    // the request side (apps/web/src/server/origin-guard.ts) compares the
    // browser's already-canonical Origin header with strict string equality,
    // so an unnormalized CONFIGURED value would reject every browser client.
    CORS_ORIGIN: z
      .url()
      .transform((value) => new URL(value).origin)
      .optional(),
    NODE_ENV: z.enum(["development", "production", "test"]),
    // MEDIUM-E (Dokploy fix): PUBLIC_BASE_URL is the public web origin used as
    // the PREFIX of every generated invitation link
    // (e.g. "https://chat.example.com"). Distinct from the asset-resolution
    // origin — in Dokploy the web container's runtime env (set inside the
    // container AFTER compose interpolation) is the single source of truth, so
    // this MUST be a runtime read (process.env via @t3-oss/env-core), NOT a
    // build-time bake. Served to the SPA by /ice-config alongside iceServers;
    // the SPA falls back to window.location.origin when unset.
    // Kept optional + `.url()` so loopback/LAN/CI deployments (which format
    // invitations from window.location.origin) keep working.
    PUBLIC_BASE_URL: z.string().url().optional(),
    // Phase 0: ICE public endpoints + the server-held shared secret used to
    // mint time-limited TURN credentials (REST API / HMAC-SHA1). The secret
    // NEVER leaves the server — only ephemeral username/credential pairs reach
    // the client via /ice-config. All optional so loopback/LAN/CI deployments
    // (which need no STUN/TURN) keep working with an empty iceServers list.
    // STUN_URL example: "stun:turn.example.com:3478".
    STUN_URL: z
      .string()
      .regex(
        STUN_URL_PATTERN,
        "must start with a stun: or stuns: scheme, e.g. stun:turn.example.com:3478",
      )
      .optional(),
    // TURN_URL example: "turn:turn.example.com:3478" (UDP/TCP relay).
    TURN_URL: z
      .string()
      .regex(
        TURN_URL_PATTERN,
        "must start with a turn: or turns: scheme, e.g. turn:turn.example.com:3478",
      )
      .optional(),
    // TURN_TLS_URL example: "turns:turn.example.com:5349" (TLS relay).
    TURN_TLS_URL: z
      .string()
      .regex(
        TURN_TLS_URL_PATTERN,
        "must start with a turns: scheme, e.g. turns:turn.example.com:5349",
      )
      .optional(),
    // TURN_SHARED_SECRET: the long-term static-auth-secret configured on the
    // coturn instance. Server-side only; used to compute per-request
    // credentials. Do NOT expose this to the client (see web.ts for the public
    // subset that ships in the browser bundle). Minimum length mirrors
    // deploy/coturn/entrypoint.sh — the entrypoint additionally rejects
    // whitespace/control chars and a leading `=`/`"` (config-render safety),
    // which only matter on the coturn side where the value is written into a
    // config file; here the entropy floor is what protects the HMAC oracle.
    TURN_SHARED_SECRET: z
      .string()
      .min(
        TURN_SHARED_SECRET_MIN_LENGTH,
        `must be at least ${TURN_SHARED_SECRET_MIN_LENGTH} characters (generate with e.g. \`openssl rand -hex 32\`)`,
      )
      .optional(),
    // TURN_REALM: the coturn `realm` directive. Must match the value the
    // server is configured with; some WebRTC stacks surface it in errors.
    TURN_REALM: z.string().optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
