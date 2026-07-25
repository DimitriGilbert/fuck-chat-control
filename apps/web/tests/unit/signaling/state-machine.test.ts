import { describe, expect, it } from "vitest";

import {
  ConnectionState,
  ConnectionStateMachine,
  GlareResolver,
  isPolite,
  resolveGlare,
} from "@/features/chat/signaling/state-machine";
import { Role } from "@/features/chat/protocol/types";

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
