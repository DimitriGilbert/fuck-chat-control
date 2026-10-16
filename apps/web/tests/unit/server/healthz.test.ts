import { describe, expect, it } from "vitest";

import healthz from "@/server/healthz";

import type { H3Event } from "nitro/h3";

/**
 * R7/F5: /healthz must fail (503) on a HALF-configured TURN setup and pass
 * on both "no TURN at all" and "fully configured" — and it must exercise the
 * credential minting path when a secret is present.
 *
 * The handler reads the app `env` snapshot, which env-core parses at import
 * time, so these tests stub `process.env` and dynamically re-import the
 * module (the same pattern the ice-config half-set warning tests use).
 */

function fakeEvent(): H3Event {
  // h3 v2 reads/writes `event.res.status`; mock just that surface.
  return { res: { status: 200 } } as unknown as H3Event;
}

function statusCodeOf(event: H3Event): number {
  return (event as unknown as { res: { status: number } }).res.status;
}

async function importFresh(): Promise<typeof healthz> {
  vi.resetModules();
  return (await import("@/server/healthz")).default;
}

import { afterEach, vi } from "vitest";

const TURN_VARS = ["TURN_URL", "TURN_TLS_URL", "TURN_SHARED_SECRET"] as const;
// ≥ 32 chars to satisfy the env schema's TURN_SHARED_SECRET floor (R15:F2) —
// importFresh() re-imports healthz, which re-parses the real env schema.
const VALID_SECRET = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  for (const k of TURN_VARS) delete process.env[k];
});

describe("/healthz (R7:F5)", () => {
  it("returns ok when no TURN is configured (intentional loopback deployment)", async () => {
    const handler = await importFresh();
    const result = handler(fakeEvent());
    expect(result).toEqual({ ok: true });
  });

  it("returns ok and mints when TURN is fully configured", async () => {
    process.env.TURN_URL = "turn:turn.example.com:3478";
    process.env.TURN_SHARED_SECRET = VALID_SECRET;
    const handler = await importFresh();
    const result = handler(fakeEvent());
    expect(result).toEqual({ ok: true });
  });

  it("returns 503 when TURN_URL is set but TURN_SHARED_SECRET is missing", async () => {
    process.env.TURN_URL = "turn:turn.example.com:3478";
    const handler = await importFresh();
    const event = fakeEvent();
    const result = handler(event);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/TURN_SHARED_SECRET is missing/);
    expect(statusCodeOf(event)).toBe(503);
  });

  it("returns 503 when TURN_SHARED_SECRET is set but no TURN URL is configured", async () => {
    process.env.TURN_SHARED_SECRET = VALID_SECRET;
    const handler = await importFresh();
    const event = fakeEvent();
    const result = handler(event);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/neither TURN_URL nor TURN_TLS_URL/);
    expect(statusCodeOf(event)).toBe(503);
  });
});
