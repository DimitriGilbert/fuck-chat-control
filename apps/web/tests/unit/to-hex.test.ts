import { describe, expect, it } from "vitest";

function toHex(bytes: ReadonlyArray<number>): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("toHex", () => {
  it("encodes each byte as a zero-padded lowercase hex pair", () => {
    expect(toHex([0, 15, 16, 255])).toBe("000f10ff");
  });

  it("returns an empty string for an empty byte list", () => {
    expect(toHex([])).toBe("");
  });
});
