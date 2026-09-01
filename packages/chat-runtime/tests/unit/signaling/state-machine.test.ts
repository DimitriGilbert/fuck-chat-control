import { describe, expect, it } from "vitest";

import {
  ConnectionState,
  ConnectionStateMachine,
  deriveGlareRole,
  deriveResumeGlareRole,
  GlareResolver,
  isPolite,
  resolveGlare,
} from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { deriveRole } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { Role, type PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";

describe("ConnectionStateMachine — valid transitions", () => {
  it("starts in idle", () => {
    const sm = new ConnectionStateMachine();
    expect(sm.getState()).toBe(ConnectionState.Idle);
  });

  it("supports the full initiator path idle -> connected", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    sm.transition(ConnectionState.Verifying);
    sm.transition(ConnectionState.Connected);
    expect(sm.getState()).toBe(ConnectionState.Connected);
  });

  it("supports join-existing path idle -> signaling", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    expect(sm.getState()).toBe(ConnectionState.Handshaking);
  });

  it("supports connected -> disconnected", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    sm.transition(ConnectionState.Verifying);
    sm.transition(ConnectionState.Connected);
    sm.transition(ConnectionState.Disconnected);
    expect(sm.getState()).toBe(ConnectionState.Disconnected);
  });

  it("supports retry from disconnected -> signaling", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Disconnected);
    sm.transition(ConnectionState.Signaling);
    expect(sm.getState()).toBe(ConnectionState.Signaling);
  });

  it("supports reset to idle from any state", () => {
    for (const from of Object.values(ConnectionState)) {
      const sm = new ConnectionStateMachine();
      if (from !== ConnectionState.Idle) {
        sm.transition(ConnectionState.Waiting);
        if (from !== ConnectionState.Waiting) {
          sm.transition(ConnectionState.Signaling);
        }
      }
      sm.transition(ConnectionState.Idle);
      expect(sm.getState()).toBe(ConnectionState.Idle);
    }
  });

  it("supports signaling -> waiting (glare rollback / retry)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Waiting);
    expect(sm.getState()).toBe(ConnectionState.Waiting);
  });
});

describe("ConnectionStateMachine — invalid transitions throw", () => {
  it("throws when transitioning from idle to connected directly", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition(ConnectionState.Connected)).toThrow();
  });

  it("throws when transitioning from idle to handshaking", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition(ConnectionState.Handshaking)).toThrow();
  });

  it("throws when transitioning from waiting to connected", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    expect(() => sm.transition(ConnectionState.Connected)).toThrow();
  });

  it("throws when transitioning from connected to signaling without disconnect", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    sm.transition(ConnectionState.Verifying);
    sm.transition(ConnectionState.Connected);
    expect(() => sm.transition(ConnectionState.Signaling)).toThrow();
  });

  it("throws when transitioning from verifying to waiting", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    sm.transition(ConnectionState.Verifying);
    expect(() => sm.transition(ConnectionState.Waiting)).toThrow();
  });

  it("throws on an unknown state value", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition("bogus" as unknown as ConnectionState)).toThrow();
  });
});

describe("perfect-negotiation role policy", () => {
  it("treats the responder as the polite peer", () => {
    expect(isPolite(Role.Responder)).toBe(true);
  });

  it("treats the initiator as the impolite peer", () => {
    expect(isPolite(Role.Initiator)).toBe(false);
  });

  it("resolveGlare keeps the initiator's offer", () => {
    expect(resolveGlare(Role.Initiator)).toBe("keep");
  });

  it("resolveGlare rolls back the responder's offer", () => {
    expect(resolveGlare(Role.Responder)).toBe("rollback");
  });
});

describe("GlareResolver — live offer tracking", () => {
  it("answers a remote offer when no local offer is in flight (polite)", () => {
    const resolver = new GlareResolver(Role.Responder);
    expect(resolver.onRemoteOffer()).toBe("answer");
  });

  it("answers a remote offer when no local offer is in flight (impolite)", () => {
    const resolver = new GlareResolver(Role.Initiator);
    expect(resolver.onRemoteOffer()).toBe("answer");
  });

  it("rolls back a polite peer's in-flight offer to answer the remote", () => {
    const resolver = new GlareResolver(Role.Responder);
    resolver.beginOffer();
    expect(resolver.onRemoteOffer()).toBe("answer");
  });

  it("ignores a remote offer when an impolite peer has one in flight (glare)", () => {
    const resolver = new GlareResolver(Role.Initiator);
    resolver.beginOffer();
    expect(resolver.onRemoteOffer()).toBe("ignore");
  });

  it("answers a remote offer again after the local offer completes", () => {
    const resolver = new GlareResolver(Role.Initiator);
    resolver.beginOffer();
    expect(resolver.onRemoteOffer()).toBe("ignore");
    resolver.endOffer();
    expect(resolver.onRemoteOffer()).toBe("answer");
  });
});

describe("deriveGlareRole — local-key parity rule (R7/F5)", () => {
  it("an even-parity first key byte derives Initiator", () => {
    const key = new Uint8Array([0x04, 0x02, 0xaa, 0xbb]);
    expect(deriveGlareRole(key)).toBe(Role.Initiator);
  });

  it("an odd-parity first key byte derives Responder", () => {
    const key = new Uint8Array([0x04, 0x03, 0xaa, 0xbb]);
    expect(deriveGlareRole(key)).toBe(Role.Responder);
  });
});

describe("deriveResumeGlareRole — §3 two-key derivation (R3F4)", () => {
  /** Hand-built SEC1 key: 0x04 prefix, chosen first X byte, chosen fill. */
  function key(firstX: number, fill: number): PublicKey {
    const bytes = new Uint8Array(33);
    bytes[0] = 0x04;
    bytes[1] = firstX;
    bytes.fill(fill, 2);
    return bytes as unknown as PublicKey;
  }

  it("follows §3: the lexicographically smaller key is Initiator on BOTH sides of the pair", () => {
    // The frozen rule (protocol-v1 §3) compares the full 65-byte keys; the
    // smaller key is the Initiator. Each side computes with (local, peer) in
    // its own order; the roles must be opposite — the perfect-negotiation
    // invariant — and must agree with the §3 deriveRole itself.
    const smaller = key(0x10, 0x10);
    const larger = key(0x20, 0x20);
    expect(deriveResumeGlareRole(smaller, larger)).toBe(Role.Initiator);
    expect(deriveResumeGlareRole(larger, smaller)).toBe(Role.Responder);
    expect(deriveResumeGlareRole(smaller, larger)).toBe(deriveRole(smaller, larger));
    expect(deriveResumeGlareRole(larger, smaller)).toBe(deriveRole(larger, smaller));
  });

  it("first-byte parity never overrides the full-key comparison (§3 has no parity branch)", () => {
    // An EVEN-parity first X byte would derive Initiator under the local-only
    // parity rule whenever the pair's parities differ, but the even-parity
    // key here is lexicographically LARGER — §3 says Responder. This is the
    // case the prior parity-split branch got wrong.
    const oddSmaller = key(0x11, 0x11);
    const evenLarger = key(0x20, 0x22);
    expect(deriveResumeGlareRole(evenLarger, oddSmaller)).toBe(Role.Responder);
    expect(deriveResumeGlareRole(oddSmaller, evenLarger)).toBe(Role.Initiator);
  });

  it("every ordered pair of distinct keys derives opposite roles (exactly one polite side)", () => {
    // Exhaustive-ish sweep over hand-built keys covering both parities:
    // whatever two distinct keys a resumed pair holds, the two orderings
    // must never agree on the role.
    const keys = [
      key(0x00, 0x00),
      key(0x00, 0x7f),
      key(0x00, 0xff),
      key(0x01, 0x00),
      key(0x01, 0x7f),
      key(0x01, 0xff),
      key(0x00, 0x55),
      key(0x01, 0x55),
    ];
    for (let i = 0; i < keys.length; i++) {
      for (let j = 0; j < keys.length; j++) {
        if (i === j) continue;
        const a = keys[i]!;
        const b = keys[j]!;
        const roleA = deriveResumeGlareRole(a, b);
        const roleB = deriveResumeGlareRole(b, a);
        expect(roleA === roleB).toBe(false);
      }
    }
  });

  it("byte-identical keys derive Responder on both sides — both polite, fails safe", () => {
    // Degenerate self-resume: §3 calls identical keys RoleIndeterminable
    // (fatal for the wire protocol); the glare-role derivation fails soft
    // instead — both Responder means neither side offers rather than both
    // sides impolitely ignoring each other.
    const k = key(0x12, 0x33);
    expect(deriveResumeGlareRole(k, k)).toBe(Role.Responder);
  });
});
