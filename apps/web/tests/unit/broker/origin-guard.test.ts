import { describe, expect, it } from "vitest";

import { isOriginAllowed } from "@/server/origin-guard";

describe("isOriginAllowed — CR-16 WebSocket origin guard", () => {
  describe("when CORS_ORIGIN is not configured (dev/local)", () => {
    it("admits any origin when the allow-list is undefined", () => {
      expect(isOriginAllowed(undefined, "https://evil.example")).toBe(true);
    });

    it("admits any origin when the allow-list is empty", () => {
      expect(isOriginAllowed("", "https://evil.example")).toBe(true);
    });

    it("admits an absent Origin header", () => {
      expect(isOriginAllowed(undefined, null)).toBe(true);
      expect(isOriginAllowed(undefined, undefined)).toBe(true);
    });
  });

  describe("when CORS_ORIGIN is configured (production)", () => {
    const allowed = "https://app.example.com";

    it("admits an exactly-matching origin", () => {
      expect(isOriginAllowed(allowed, allowed)).toBe(true);
    });

    it("rejects a mismatched origin", () => {
      expect(isOriginAllowed(allowed, "https://evil.example")).toBe(false);
    });

    it("rejects a spoofed look-alike origin (exact match only)", () => {
      expect(isOriginAllowed(allowed, "https://app.example.com.evil.example")).toBe(
        false,
      );
      expect(isOriginAllowed(allowed, "https://app.example.com:443")).toBe(false);
    });
  });

  describe("absent Origin header (non-browser clients)", () => {
    it("is admitted even when CORS_ORIGIN is set", () => {
      // The threat model is browser cross-origin tabs, which always send Origin.
      // Headerless clients (curl, the `ws` CLI library) are admitted; the
      // broker is signaling-only so the residual risk is room-occupation DoS,
      // which the PRD scopes out of v1.
      expect(isOriginAllowed("https://app.example.com", null)).toBe(true);
      expect(isOriginAllowed("https://app.example.com", undefined)).toBe(true);
      expect(isOriginAllowed("https://app.example.com", "")).toBe(true);
    });
  });
});
