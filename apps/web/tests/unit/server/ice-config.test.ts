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
