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
});
