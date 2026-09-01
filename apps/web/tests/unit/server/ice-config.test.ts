import type { H3Event } from "nitro/h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildIceServers, mintTurnCredentials } from "@/server/ice-config";

/**
 * Phase 0 /ice-config: assert the credential-minting format and the
 * env-driven server list composition. These target the pure helpers exported
 * from ice-config.ts so the suite does not need to stand up the dev server —
 * the live HTTP path is exercised by the integration suite (see
 * apps/web/tests/integration/broker-ws.test.ts for the dev-server harness
 * pattern; a dedicated /ice-config HTTP test is out of scope for Phase 0).
 *
 * `buildIceServers` is a pure function of `(IceEnv, now)` so each case passes
 * a literal env snapshot. This sidesteps env-core's eager parsing
 * (`createEnv` snapshots `process.env` once at import, so `vi.stubEnv` after
 * import has no effect) and keeps the assertions deterministic.
 */

// Reference HMAC-SHA1 expected by the TURN REST API. Computed with the same
// node:crypto the route uses, so a regression in either the digest algorithm
// or the username format surfaces here without re-implementing HMAC.
function expectedCredential(secret: string, username: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  return createHmac("sha1", secret).update(username).digest("base64");
}

const STUN_URL = "stun:turn.example.com:3478";
const TURN_URL = "turn:turn.example.com:3478";
const TURN_TLS_URL = "turns:turn.example.com:5349";
const SHARED_SECRET = "shared-secret-value";

describe("mintTurnCredentials — TURN REST API format", () => {
  it("produces username = '<expiry>:<32-hex random id>' (R7:F1 per-request entropy)", () => {
    const now = 1_700_000_000;
    const ttl = 3600;
    const { username } = mintTurnCredentials("secret", now, ttl);
    // The expiry prefix is now + ttl; the id is 16 CSPRNG bytes as hex.
    expect(username).toMatch(new RegExp(`^${now + ttl}:[0-9a-f]{32}$`));
  });

  it("produces base64(HMAC-SHA1(secret, username)) for the credential", () => {
    const now = 1_700_000_000;
    const { username, credential } = mintTurnCredentials("topsecret", now);
    expect(credential).toBe(expectedCredential("topsecret", username));
  });

  it("changes the credential when the expiry changes", () => {
    // Two mints a second apart must produce different usernames (different
    // expiry prefix) and therefore different HMACs.
    const a = mintTurnCredentials("secret", 1_000);
    const b = mintTurnCredentials("secret", 1_001);
    expect(a.username).not.toBe(b.username);
    expect(a.credential).not.toBe(b.credential);
  });

  it("mints a FRESH random id per call — two mints in the same second differ (R7:F1)", () => {
    const a = mintTurnCredentials("secret", 1_000);
    const b = mintTurnCredentials("secret", 1_000);
    expect(a.username).not.toBe(b.username);
    expect(a.credential).not.toBe(b.credential);
  });

  it("does NOT embed any identity material in the username", () => {
    // The username's id component is pure CSPRNG entropy; it carries no
    // device, session, or user identifier that would leak into coturn's
    // allocation logs. This is what keeps the TURN REST API consistent with
    // the deployment guide's "no identity material leaves the client" stance.
    const { username } = mintTurnCredentials("secret", 1_700_000_000);
    const id = username.split(":")[1]!;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("buildIceServers — env-driven composition", () => {
  it("returns an empty list when nothing is configured (loopback/CI)", () => {
    expect(buildIceServers({}, 1_700_000_000)).toEqual([]);
  });

  it("includes a STUN entry with no credentials when only STUN_URL is set", () => {
    expect(buildIceServers({ STUN_URL }, 1_700_000_000)).toEqual([{ urls: STUN_URL }]);
  });

  it("omits TURN when the URL is set but the shared secret is missing", () => {
    // Partial misconfiguration must degrade gracefully, not throw.
    expect(buildIceServers({ STUN_URL, TURN_URL }, 1_700_000_000)).toEqual([{ urls: STUN_URL }]);
  });

  it("omits TURN when the secret is set but the URL is missing", () => {
    // The symmetric partial-misconfiguration case.
    expect(buildIceServers({ STUN_URL, TURN_SHARED_SECRET: SHARED_SECRET }, 1_700_000_000)).toEqual(
      [{ urls: STUN_URL }],
    );
  });

  it("mints credentials for both TURN and TURN-TLS when fully configured", () => {
    const now = 1_700_000_000;
    const servers = buildIceServers(
      {
        STUN_URL,
        TURN_URL,
        TURN_TLS_URL,
        TURN_SHARED_SECRET: SHARED_SECRET,
      },
      now,
    );
    expect(servers).toHaveLength(3);

    const stun = servers[0]!;
    expect(stun.urls).toBe(STUN_URL);
    expect(stun.username).toBeUndefined();
    expect(stun.credential).toBeUndefined();

    const turn = servers[1]!;
    expect(turn.urls).toBe(TURN_URL);
    expect(turn.username).toMatch(new RegExp(`^${now + 2 * 60 * 60}:[0-9a-f]{32}$`));
    expect(turn.credential).toBe(expectedCredential(SHARED_SECRET, turn.username as string));

    const turns = servers[2]!;
    expect(turns.urls).toBe(TURN_TLS_URL);
    // R7/F1: each entry carries its own fresh random id (not a shared one).
    expect(turns.username).not.toBe(turn.username);
    expect(turns.credential).toBe(expectedCredential(SHARED_SECRET, turns.username as string));
  });

  it("emits RTCIceServer-shaped entries (urls: string, optional username/credential)", () => {
    const servers = buildIceServers(
      { STUN_URL, TURN_URL, TURN_SHARED_SECRET: SHARED_SECRET },
      1_700_000_000,
    );
    for (const s of servers) {
      expect(typeof s.urls === "string" || Array.isArray(s.urls)).toBe(true);
      if (s.username !== undefined) {
        expect(typeof s.username).toBe("string");
        expect(typeof s.credential).toBe("string");
      }
    }
  });
});

/**
 * The half-set warning lives at module scope (it must fire exactly once on
 * import). Each case therefore resets the module registry, stubs the relevant
 * TURN env vars, and dynamically re-imports `ice-config.ts` so the module-scope
 * check re-evaluates against the freshly-stubbed `process.env`. `console.warn`
 * is spied per-case so call counts are independent.
 */
describe("half-set TURN env — startup warning", () => {
  const TURN_VARS = ["TURN_URL", "TURN_TLS_URL", "TURN_SHARED_SECRET"] as const;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const k of TURN_VARS) delete process.env[k];
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.resetModules();
    for (const k of TURN_VARS) delete process.env[k];
  });

  it("does NOT warn when neither TURN var is set", async () => {
    await import("@/server/ice-config");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn when both TURN_URL and TURN_SHARED_SECRET are set", async () => {
    process.env.TURN_URL = TURN_URL;
    process.env.TURN_SHARED_SECRET = SHARED_SECRET;
    await import("@/server/ice-config");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns exactly once when TURN_URL is set but TURN_SHARED_SECRET is missing", async () => {
    process.env.TURN_URL = TURN_URL;
    await import("@/server/ice-config");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/TURN_SHARED_SECRET is missing/);
  });

  it("warns when TURN_SHARED_SECRET is set but neither TURN URL is configured", async () => {
    process.env.TURN_SHARED_SECRET = SHARED_SECRET;
    await import("@/server/ice-config");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/TURN_URL nor TURN_TLS_URL is configured/);
  });
});

/**
 * R5:F2: the limiter must key buckets on the SOCKET peer address — never on
 * X-Forwarded-For — and an overflow of the bucket table must evict the
 * least-recently-used entry instead of flushing every honest client's bucket.
 *
 * Each case resets the module registry and dynamically re-imports the route
 * so the module-scope `rateBuckets` table starts empty (the healthz suite's
 * importFresh pattern). The fake event exercises the real h3 helpers:
 * `getRequestIP(event)` reads `event.req.context.clientAddress` (the
 * transport-level socket peer), `setHeader`/`setResponseStatus` write
 * `event.res`, and the client-supplied `x-forwarded-for` REQUEST header is
 * present so any regression back to leftmost-XFF keying fails these tests —
 * each spoofed value would mint a fresh 20-token bucket and the 429
 * assertions below would observe 200s instead.
 */
describe("rate limiting — socket-peer keying + LRU-bounded table (R5:F2)", () => {
  interface FakeResponse {
    status: number;
    headers: Headers;
  }

  type IceConfigRoute = typeof import("@/server/ice-config");

  function fakeEvent(
    peerAddress: string,
    forwardedFor?: string,
  ): { event: H3Event; res: FakeResponse } {
    const reqHeaders = new Headers();
    if (forwardedFor !== undefined) {
      reqHeaders.set("x-forwarded-for", forwardedFor);
    }
    const res: FakeResponse = { status: 200, headers: new Headers() };
    const event = {
      req: { headers: reqHeaders, context: { clientAddress: peerAddress } },
      res,
    } as unknown as H3Event;
    return { event, res };
  }

  async function importFreshRoute(): Promise<IceConfigRoute> {
    vi.resetModules();
    return import("@/server/ice-config");
  }

  function respond(
    handler: IceConfigRoute["default"],
    peerAddress: string,
    forwardedFor?: string,
  ): { status: number; body: ReturnType<IceConfigRoute["default"]>; res: FakeResponse } {
    const { event, res } = fakeEvent(peerAddress, forwardedFor);
    const body = handler(event);
    return { status: res.status, body, res };
  }

  it("rotating attacker-chosen X-Forwarded-For values from ONE socket peer hit ONE bucket and get limited", async () => {
    const route = await importFreshRoute();
    const peer = "203.0.113.7";
    // 20 requests, each spoofing a DIFFERENT leftmost XFF value — the exact
    // posture that minted a fresh 20-token bucket per request under the old
    // leftmost-XFF keying. All 20 must drain the peer's single bucket.
    for (let i = 0; i < 20; i += 1) {
      const r = respond(route.default, peer, `198.51.100.${i + 1}, 10.0.0.99`);
      expect(r.status).toBe(200);
    }
    // 21st from the same peer — even with yet another fresh spoofed value —
    // is a 429 carrying the empty-list body and a no-store cache directive.
    const limited = respond(route.default, peer, "192.0.2.222");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ iceServers: [] });
    expect(limited.res.headers.get("cache-control")).toBe("no-store");
  });

  it("a request with NO X-Forwarded-For shares its socket peer's bucket", async () => {
    const route = await importFreshRoute();
    const peer = "198.18.0.1";
    for (let i = 0; i < 20; i += 1) {
      expect(respond(route.default, peer, `203.0.113.${i + 1}`).status).toBe(200);
    }
    // Header absent entirely: same socket peer, same drained bucket.
    expect(respond(route.default, peer).status).toBe(429);
  });

  it("distinct socket peers get distinct buckets; an XFF naming a limited peer inherits nothing", async () => {
    const route = await importFreshRoute();
    const a = "198.51.100.10";
    const b = "198.51.100.11";
    for (let i = 0; i < 20; i += 1) {
      expect(respond(route.default, a, `203.0.113.${i + 1}`).status).toBe(200);
    }
    expect(respond(route.default, a).status).toBe(429);
    // Peer B dials in claiming (via XFF) to BE the limited peer A — it must
    // not inherit A's drained bucket, and A's exhaustion must not limit B.
    expect(respond(route.default, b, a).status).toBe(200);
  });

  it("tracker overflow evicts the LRU entry — other IPs' partial buckets survive (no flush)", async () => {
    const route = await importFreshRoute();
    const max = route.RATE_TRACKER_MAX_IPS;
    // One filler peer per table entry, leaving room for the victim below.
    // fillerPeer(0) is the first-inserted and never touched again, so it is
    // the least-recently-used entry at overflow time.
    const fillerPeer = (i: number): string =>
      `10.${Math.floor(i / 65_536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`;
    for (let i = 0; i < max - 1; i += 1) {
      respond(route.default, fillerPeer(i));
    }
    // Victim brings the table exactly to capacity and spends one token
    // (19 remain).
    expect(respond(route.default, "198.51.100.50").status).toBe(200);
    // The overflow: one more DISTINCT peer. The old `rateBuckets.clear()`
    // flushed the whole table here — resetting the victim's bucket to a full
    // 20 tokens; LRU eviction must evict fillerPeer(0) instead.
    expect(respond(route.default, "198.51.100.99").status).toBe(200);
    // Victim's bucket survived the overflow with its 19 remaining tokens:
    // exactly 19 more allows, then 429. A flushed table would allow a 20th.
    for (let i = 0; i < 19; i += 1) {
      expect(respond(route.default, "198.51.100.50").status).toBe(200);
    }
    expect(respond(route.default, "198.51.100.50").status).toBe(429);
    // The eviction hit the LRU entry (fillerPeer(0)), which starts fresh.
    expect(respond(route.default, fillerPeer(0)).status).toBe(200);
  });
});
