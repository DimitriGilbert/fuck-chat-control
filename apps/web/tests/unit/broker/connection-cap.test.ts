import { describe, expect, it } from "vitest";

import { MAX_CONNECTIONS, shouldRejectConnection } from "@/server/broker";

describe("broker connection cap — R3/F2 (MAX_CONNECTIONS)", () => {
  it("exports MAX_CONNECTIONS with the documented v1 default", () => {
    expect(MAX_CONNECTIONS).toBe(2048);
  });

  it("admits a connection below the cap", () => {
    expect(shouldRejectConnection(0, 2)).toBe(false);
    expect(shouldRejectConnection(1, 2)).toBe(false);
    expect(shouldRejectConnection(2047, 2048)).toBe(false);
  });

  it("rejects once the cap is reached (current >= max)", () => {
    expect(shouldRejectConnection(2, 2)).toBe(true);
    expect(shouldRejectConnection(3, 2)).toBe(true);
    expect(shouldRejectConnection(2048, 2048)).toBe(true);
  });

  it("admits the very first connection when the cap is at least 1", () => {
    expect(shouldRejectConnection(0, 1)).toBe(false);
    expect(shouldRejectConnection(1, 1)).toBe(true);
  });
});
