import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    // CR-16: optional so an unset var is a no-op in the broker's origin guard
    // (dev/preview/local never configure it). Enforced only when an operator
    // sets it in production — see apps/web/src/server/broker.ts.
    CORS_ORIGIN: z.url().optional(),
    NODE_ENV: z.enum(["development", "production", "test"]),
    // Phase 0: ICE public endpoints + the server-held shared secret used to
    // mint time-limited TURN credentials (REST API / HMAC-SHA1). The secret
    // NEVER leaves the server — only ephemeral username/credential pairs reach
    // the client via /ice-config. All optional so loopback/LAN/CI deployments
    // (which need no STUN/TURN) keep working with an empty iceServers list.
    // STUN_URL example: "stun:turn.example.com:3478".
    STUN_URL: z.string().optional(),
    // TURN_URL example: "turn:turn.example.com:3478" (UDP/TCP relay).
    TURN_URL: z.string().optional(),
    // TURN_TLS_URL example: "turns:turn.example.com:5349" (TLS relay).
    TURN_TLS_URL: z.string().optional(),
    // TURN_SHARED_SECRET: the long-term static-auth-secret configured on the
    // coturn instance. Server-side only; used to compute per-request
    // credentials. Do NOT expose this to the client (see web.ts for the public
    // subset that ships in the browser bundle).
    TURN_SHARED_SECRET: z.string().optional(),
    // TURN_REALM: the coturn `realm` directive. Must match the value the
    // server is configured with; some WebRTC stacks surface it in errors.
    TURN_REALM: z.string().optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
