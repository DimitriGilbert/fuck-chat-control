import { describe, expect, it } from "vitest";

import { readInvitationFragment } from "@/features/chat/ui/invitation-fragment";

describe("readInvitationFragment", () => {
  it("returns null for an empty hash", () => {
    expect(readInvitationFragment("")).toBeNull();
  });

  it("returns the fragment for a well-formed hash", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    expect(readInvitationFragment(`#${hex}`)).toBe(hex);
  });

  it("accepts a bare fragment without the leading hash", () => {
    const hex = "fedcba9876543210fedcba9876543210";
    expect(readInvitationFragment(hex)).toBe(hex);
  });

  it("returns null for too-short input", () => {
    expect(readInvitationFragment("#abc")).toBeNull();
  });

  it("returns null when uppercase hex is present", () => {
    expect(readInvitationFragment("#ABCDEF0123456789ABCDEF0123456789")).toBeNull();
  });

  it("returns null for non-hex characters of the right length", () => {
    expect(readInvitationFragment("#zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
  });

  it("returns null when extra characters are appended", () => {
    expect(readInvitationFragment("#0123456789abcdef0123456789abcdef trailing")).toBeNull();
  });

  describe("PAKE code suffix (R7/F6 / Phase 8.3, LW-9 PRD #90)", () => {
    it("accepts a hex~code fragment and returns the full bare fragment", () => {
      const hex = "0123456789abcdef0123456789abcdef";
      const fragment = `${hex}~123456`;
      expect(readInvitationFragment(`#${fragment}`)).toBe(fragment);
    });

    it("accepts a bare hex~code fragment without the leading hash", () => {
      const hex = "fedcba9876543210fedcba9876543210";
      const fragment = `${hex}~654321`;
      expect(readInvitationFragment(fragment)).toBe(fragment);
    });

    it("accepts the minimum 6-digit code length (000000)", () => {
      const hex = "0123456789abcdef0123456789abcdef";
      const fragment = `${hex}~000000`;
      expect(readInvitationFragment(`#${fragment}`)).toBe(fragment);
    });

    it("accepts the maximum 6-digit code length", () => {
      const hex = "0123456789abcdef0123456789abcdef";
      // 7 digits is over the cap — should be rejected.
      expect(readInvitationFragment(`#${hex}~0000000`)).toBeNull();
      // Exactly 6 digits is valid.
      const valid = `${hex}~999999`;
      expect(readInvitationFragment(`#${valid}`)).toBe(valid);
    });

    it("rejects a 1..5-digit code (PRD #90 requires exactly 6 digits)", () => {
      const hex = "0123456789abcdef0123456789abcdef";
      expect(readInvitationFragment(`#${hex}~7`)).toBeNull();
      expect(readInvitationFragment(`#${hex}~42`)).toBeNull();
      expect(readInvitationFragment(`#${hex}~12345`)).toBeNull();
    });

    it("rejects a 7+ digit code (above the cap)", () => {
      const hex = "0123456789abcdef0123456789abcdef";
      expect(readInvitationFragment(`#${hex}~1234567`)).toBeNull();
    });

    it("rejects a non-numeric code", () => {
      const hex = "0123456789abcdef0123456789abcdef";
      expect(readInvitationFragment(`#${hex}~abcdef`)).toBeNull();
    });

    it("rejects a code with non-digit characters mixed in", () => {
      const hex = "0123456789abcdef0123456789abcdef";
      expect(readInvitationFragment(`#${hex}~12a456`)).toBeNull();
    });

    it("rejects a trailing tilde with no digits", () => {
      const hex = "0123456789abcdef0123456789abcdef";
      expect(readInvitationFragment(`#${hex}~`)).toBeNull();
    });

    it("rejects a second tilde", () => {
      const hex = "0123456789abcdef0123456789abcdef";
      expect(readInvitationFragment(`#${hex}~123~456`)).toBeNull();
    });

    it("rejects an uppercase X in the code position", () => {
      const hex = "0123456789abcdef0123456789abcdef";
      // Tilde must be followed by digits only.
      expect(readInvitationFragment(`#${hex}~X23456`)).toBeNull();
    });
  });
});
