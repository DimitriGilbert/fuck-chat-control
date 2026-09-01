import { describe, expect, it } from "vitest";

import { zeroize } from "@fuck-eu-chat-control/chat-runtime/crypto/primitives";

/**
 * R1:F3 — best-effort key zeroization helper. The helper overwrites the byte
 * range backing its argument with zeros, honoring subarray views (byteOffset /
 * byteLength) so it wipes exactly the secret bytes the caller handed in, even
 * for a view onto a larger buffer. These tests pin:
 *  - a full Uint8Array is filled with zeros,
 *  - a subarray view wipes ONLY its slice (the surrounding bytes are untouched),
 *  - a DataView view is wiped (the helper handles any ArrayBufferView),
 *  - buffers that are already zero are idempotent.
 *
 * The helper is best-effort in JS (GC / runtime buffer copies are not reached),
 * but these tests pin the bytes the caller CAN reach are zeroed.
 */
describe("zeroize (R1:F3, best-effort key zeroization)", () => {
  it("fills a full Uint8Array with zeros", () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    zeroize(buf);
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("wipes only the viewed slice of a subarray (surrounding bytes untouched)", () => {
    const parent = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    // View bytes [2..6) of the parent.
    const view = parent.subarray(2, 6);
    zeroize(view);
    // The viewed slice is zeroed...
    expect(Array.from(view)).toEqual([0, 0, 0, 0]);
    // ...and the surrounding parent bytes are LEFT INTACT. This is the property
    // that lets zeroize be safe to call on a slice of a larger buffer (e.g. the
    // ECDH X-coordinate subarray, or a field extracted via subarray).
    expect(Array.from(parent)).toEqual([10, 20, 0, 0, 0, 0, 70, 80]);
  });

  it("wipes a DataView view over a slice", () => {
    const parent = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    // A DataView over bytes [1..5) of the parent.
    const view = new DataView(parent.buffer, 1, 4);
    zeroize(view);
    expect(Array.from(parent)).toEqual([0xaa, 0, 0, 0, 0, 0xff]);
  });

  it("wipes an Int32Array view (any ArrayBufferView)", () => {
    const buf = new ArrayBuffer(8);
    const view = new Int32Array(buf);
    view[0] = 0x01020304;
    view[1] = 0x05060708;
    zeroize(view);
    expect(view[0]).toBe(0);
    expect(view[1]).toBe(0);
  });

  it("is idempotent on an already-zero buffer", () => {
    const buf = new Uint8Array(8); // already zero
    zeroize(buf);
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("handles a zero-length view without throwing", () => {
    const parent = new Uint8Array([1, 2, 3]);
    const empty = parent.subarray(1, 1);
    expect(() => zeroize(empty)).not.toThrow();
    // Parent is untouched.
    expect(Array.from(parent)).toEqual([1, 2, 3]);
  });
});
