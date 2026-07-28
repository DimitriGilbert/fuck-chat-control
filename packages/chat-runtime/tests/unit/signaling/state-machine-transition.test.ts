import { describe, expect, it } from "vitest";

import {
  ConnectionState,
  ConnectionStateMachine,
  InvalidTransitionError,
} from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";

describe("ConnectionStateMachine — illegal transitions throw InvalidTransitionError", () => {
  it("throws InvalidTransitionError on idle -> connected", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition(ConnectionState.Connected)).toThrow(InvalidTransitionError);
    expect(() => sm.transition(ConnectionState.Connected)).toThrow(
      /Invalid connection transition: idle -> connected/,
    );
  });

  it("throws InvalidTransitionError on idle -> handshaking", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition(ConnectionState.Handshaking)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on idle -> verifying", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition(ConnectionState.Verifying)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on idle -> disconnected", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition(ConnectionState.Disconnected)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on waiting -> connected", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    expect(() => sm.transition(ConnectionState.Connected)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on waiting -> verifying", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    expect(() => sm.transition(ConnectionState.Verifying)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on handshaking -> connected (must pass Verifying)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    expect(() => sm.transition(ConnectionState.Connected)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on connected -> handshaking", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    sm.transition(ConnectionState.Verifying);
    sm.transition(ConnectionState.Connected);
    expect(() => sm.transition(ConnectionState.Handshaking)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on connected -> verifying", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    sm.transition(ConnectionState.Verifying);
    sm.transition(ConnectionState.Connected);
    expect(() => sm.transition(ConnectionState.Verifying)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on verifying -> signaling", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    sm.transition(ConnectionState.Verifying);
    expect(() => sm.transition(ConnectionState.Signaling)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on disconnected -> connected (must re-handshake)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Disconnected);
    expect(() => sm.transition(ConnectionState.Connected)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on disconnected -> handshaking", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Disconnected);
    expect(() => sm.transition(ConnectionState.Handshaking)).toThrow(InvalidTransitionError);
  });

  it("throws InvalidTransitionError on disconnected -> verifying", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Disconnected);
    expect(() => sm.transition(ConnectionState.Verifying)).toThrow(InvalidTransitionError);
  });

  it("throws on an unknown state value", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition("bogus" as unknown as ConnectionState)).toThrow(
      InvalidTransitionError,
    );
  });

  it("preserves the from-state on a failed transition (no partial mutation)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    expect(() => sm.transition(ConnectionState.Connected)).toThrow(InvalidTransitionError);
    expect(sm.getState()).toBe(ConnectionState.Waiting);
  });

  it("surfaces from and to on the error", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    let caught: InvalidTransitionError | null = null;
    try {
      sm.transition(ConnectionState.Connected);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        caught = err;
      }
    }
    expect(caught).not.toBeNull();
    expect(caught!.from).toBe(ConnectionState.Waiting);
    expect(caught!.to).toBe(ConnectionState.Connected);
  });
});

describe("ConnectionStateMachine — Verifying state transitions", () => {
  it("allows handshaking -> verifying -> connected", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    sm.transition(ConnectionState.Verifying);
    sm.transition(ConnectionState.Connected);
    expect(sm.getState()).toBe(ConnectionState.Connected);
  });

  it("allows verifying -> disconnected (auth failure path)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    sm.transition(ConnectionState.Verifying);
    sm.transition(ConnectionState.Disconnected);
    expect(sm.getState()).toBe(ConnectionState.Disconnected);
  });

  it("allows verifying -> idle (reset)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Signaling);
    sm.transition(ConnectionState.Handshaking);
    sm.transition(ConnectionState.Verifying);
    sm.transition(ConnectionState.Idle);
    expect(sm.getState()).toBe(ConnectionState.Idle);
  });

  it("allows waiting -> handshaking (transport attached before peer-join)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition(ConnectionState.Waiting);
    sm.transition(ConnectionState.Handshaking);
    expect(sm.getState()).toBe(ConnectionState.Handshaking);
  });
});
