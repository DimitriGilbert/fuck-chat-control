import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Server env schema (src/server.ts) regression coverage:
 *
 *   - R15:F2       TURN_SHARED_SECRET minimum entropy (≥ 32 chars).
 *   - R15:F3+R9:F1 ICE endpoint URLs must carry an RFC 7064/7065 scheme.
 *   - R4:F3        CORS_ORIGIN is canonicalized at parse time.
 *
 * `createEnv` snapshots `process.env` ONCE at module import, so each case
 * stubs the vars it exercises, resets the module registry, and dynamically
 * re-imports the schema module. A schema rejection therefore surfaces as a
 * rejected import promise; a pass surfaces as the parsed (and transformed)
 * `env` object. Every schema var is stubbed to `undefined` first so the
 * ambient environment (e.g. a developer shell exporting TURN vars) can never
 * leak into a case.
 */

const SERVER_ENV_VARS = [
  "CORS_ORIGIN",
  "PUBLIC_BASE_URL",
  "STUN_URL",
  "TURN_URL",
  "TURN_TLS_URL",
  "TURN_SHARED_SECRET",
  "TURN_REALM",
  "SKIP_ENV_VALIDATION",
] as const;

function stubServerEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const name of SERVER_ENV_VARS) {
    vi.stubEnv(name, undefined);
  }
  for (const [name, value] of Object.entries(overrides)) {
    vi.stubEnv(name, value);
  }
}

async function importServerEnv() {
  vi.resetModules();
  return import("../../src/server");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("TURN_SHARED_SECRET — R15:F2 minimum entropy", () => {
  it("stays optional (unset is a valid no-TURN deployment)", async () => {
    stubServerEnv();
    const { env } = await importServerEnv();
    expect(env.TURN_SHARED_SECRET).toBeUndefined();
  });

  it("rejects a secret shorter than 32 characters", async () => {
    stubServerEnv({ TURN_SHARED_SECRET: "a".repeat(31) });
    await expect(importServerEnv()).rejects.toThrow();
  });

  it("rejects a trivially weak short secret", async () => {
    stubServerEnv({ TURN_SHARED_SECRET: "password" });
    await expect(importServerEnv()).rejects.toThrow();
  });

  it("accepts a secret of exactly 32 characters", async () => {
    const secret = "a".repeat(32);
    stubServerEnv({ TURN_SHARED_SECRET: secret });
    const { env } = await importServerEnv();
    expect(env.TURN_SHARED_SECRET).toBe(secret);
  });

  it("accepts a longer secret unchanged", async () => {
    const secret = "deadbeef".repeat(16);
    stubServerEnv({ TURN_SHARED_SECRET: secret });
    const { env } = await importServerEnv();
    expect(env.TURN_SHARED_SECRET).toBe(secret);
  });
});

describe("ICE URL schemes — R15:F3 + R9:F1", () => {
  it.each(["STUN_URL", "TURN_URL", "TURN_TLS_URL"] as const)(
    "rejects a schemeless host:port for %s",
    async (name) => {
      stubServerEnv({ [name]: "turn.example.com:3478" });
      await expect(importServerEnv()).rejects.toThrow();
    },
  );

  it.each(["STUN_URL", "TURN_URL", "TURN_TLS_URL"] as const)(
    "rejects a bare scheme with no host for %s",
    async (name) => {
      stubServerEnv({ [name]: name === "STUN_URL" ? "stun:" : "turn:" });
      await expect(importServerEnv()).rejects.toThrow();
    },
  );

  it.each(["STUN_URL", "TURN_URL", "TURN_TLS_URL"] as const)(
    "rejects an http(s) URL for %s",
    async (name) => {
      stubServerEnv({ [name]: "https://turn.example.com:3478" });
      await expect(importServerEnv()).rejects.toThrow();
    },
  );

  it.each(["stun:turn.example.com:3478", "stuns:turn.example.com:3479"] as const)(
    "accepts %s for STUN_URL",
    async (value) => {
      stubServerEnv({ STUN_URL: value });
      const { env } = await importServerEnv();
      expect(env.STUN_URL).toBe(value);
    },
  );

  it("rejects a turn: URL for STUN_URL (STUN entries never carry credentials)", async () => {
    stubServerEnv({ STUN_URL: "turn:turn.example.com:3478" });
    await expect(importServerEnv()).rejects.toThrow();
  });

  it.each(["turn:turn.example.com:3478", "turns:turn.example.com:5349"] as const)(
    "accepts %s for TURN_URL (credentials are minted for both schemes)",
    async (value) => {
      stubServerEnv({ TURN_URL: value });
      const { env } = await importServerEnv();
      expect(env.TURN_URL).toBe(value);
    },
  );

  it("rejects a stun: URL for TURN_URL", async () => {
    stubServerEnv({ TURN_URL: "stun:turn.example.com:3478" });
    await expect(importServerEnv()).rejects.toThrow();
  });

  it("accepts a turns: URL for TURN_TLS_URL", async () => {
    const value = "turns:turn.example.com:5349";
    stubServerEnv({ TURN_TLS_URL: value });
    const { env } = await importServerEnv();
    expect(env.TURN_TLS_URL).toBe(value);
  });

  it("rejects a turn: URL for TURN_TLS_URL — the var exists only for the TLS relay", async () => {
    // Documented strictness in server.ts: a turn: value here is an operator
    // slip that would silently leave coturn's TLS listener unused. The
    // equivalent working config is `turns:` on either TURN var.
    stubServerEnv({ TURN_TLS_URL: "turn:turn.example.com:5349" });
    await expect(importServerEnv()).rejects.toThrow();
  });

  it("accepts a TURN URL with a transport query suffix", async () => {
    const value = "turn:turn.example.com:3478?transport=tcp";
    stubServerEnv({ TURN_URL: value });
    const { env } = await importServerEnv();
    expect(env.TURN_URL).toBe(value);
  });
});

describe("CORS_ORIGIN — R4:F3 canonicalization", () => {
  it("stays optional (unset is a valid dev/local deployment)", async () => {
    stubServerEnv();
    const { env } = await importServerEnv();
    expect(env.CORS_ORIGIN).toBeUndefined();
  });

  it("rejects a non-URL value", async () => {
    stubServerEnv({ CORS_ORIGIN: "app.example.com" });
    await expect(importServerEnv()).rejects.toThrow();
  });

  it("strips a trailing slash", async () => {
    stubServerEnv({ CORS_ORIGIN: "https://app.example.com/" });
    const { env } = await importServerEnv();
    expect(env.CORS_ORIGIN).toBe("https://app.example.com");
  });

  it("drops the default port and path", async () => {
    stubServerEnv({ CORS_ORIGIN: "https://app.example.com:443/some/path" });
    const { env } = await importServerEnv();
    expect(env.CORS_ORIGIN).toBe("https://app.example.com");
  });

  it("lowercases scheme and host", async () => {
    stubServerEnv({ CORS_ORIGIN: "HTTPS://APP.EXAMPLE.COM" });
    const { env } = await importServerEnv();
    expect(env.CORS_ORIGIN).toBe("https://app.example.com");
  });

  it("preserves a non-default port", async () => {
    stubServerEnv({ CORS_ORIGIN: "https://app.example.com:8443/" });
    const { env } = await importServerEnv();
    expect(env.CORS_ORIGIN).toBe("https://app.example.com:8443");
  });

  it("leaves an already-canonical origin unchanged", async () => {
    stubServerEnv({ CORS_ORIGIN: "https://app.example.com" });
    const { env } = await importServerEnv();
    expect(env.CORS_ORIGIN).toBe("https://app.example.com");
  });
});
