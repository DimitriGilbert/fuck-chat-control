import { p256 } from "@noble/curves/p256";
import { describe, expect, it } from "vitest";

import { deriveRole } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import {
  ProtocolError,
  ProtocolErrorCode,
} from "@fuck-eu-chat-control/chat-runtime/protocol/errors";
import { Role, type PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

function pubKey(seed: number): PublicKey {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = (seed * 13 + i) & 0xff;
  return p256.getPublicKey(sk, false) as unknown as PublicKey;
}

describe("deriveRole (smaller identity key bytes is initiator)", () => {
  it("assigns initiator to the lexicographically smaller key", () => {
    const a = pubKey(1);
    const b = pubKey(2);
    const cmp = compareBytes(a, b);
    expect(cmp).not.toBe(0);
    const smaller = cmp < 0 ? a : b;
    const larger = cmp < 0 ? b : a;
    expect(deriveRole(smaller, larger)).toBe(Role.Initiator);
    expect(deriveRole(larger, smaller)).toBe(Role.Responder);
  });

  it("is symmetric: both peers agree on who is initiator", () => {
    const a = pubKey(5);
    const b = pubKey(9);
    const aRole = deriveRole(a, b);
    const bRole = deriveRole(b, a);
    expect(aRole).not.toBe(bRole);
  });

  it("throws RoleIndeterminable when identity keys are identical", () => {
    const a = pubKey(7);
    try {
      deriveRole(a, a);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ProtocolErrorCode.RoleIndeterminable);
    }
  });
});

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
