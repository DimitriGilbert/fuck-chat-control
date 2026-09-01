import { Role } from "../protocol/types";
import type { PublicKey } from "../protocol/types";
import { deriveRole } from "../protocol/codec";

export const ConnectionState = {
  Idle: "idle",
  Waiting: "waiting",
  Signaling: "signaling",
  Handshaking: "handshaking",
  Verifying: "verifying",
  Connected: "connected",
  Disconnected: "disconnected",
} as const;
export type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];

const CONNECTION_STATE_VALUES: ReadonlySet<ConnectionState> = new Set(
  Object.values(ConnectionState),
);

const TRANSITIONS: Record<ConnectionState, ReadonlySet<ConnectionState>> = {
  [ConnectionState.Idle]: new Set<ConnectionState>([
    ConnectionState.Waiting,
    ConnectionState.Signaling,
    ConnectionState.Idle,
  ]),
  [ConnectionState.Waiting]: new Set<ConnectionState>([
    ConnectionState.Signaling,
    ConnectionState.Handshaking,
    ConnectionState.Disconnected,
    ConnectionState.Idle,
  ]),
  [ConnectionState.Signaling]: new Set<ConnectionState>([
    ConnectionState.Handshaking,
    ConnectionState.Waiting,
    ConnectionState.Disconnected,
    ConnectionState.Idle,
  ]),
  [ConnectionState.Handshaking]: new Set<ConnectionState>([
    ConnectionState.Verifying,
    ConnectionState.Disconnected,
    ConnectionState.Idle,
  ]),
  [ConnectionState.Verifying]: new Set<ConnectionState>([
    ConnectionState.Connected,
    ConnectionState.Disconnected,
    ConnectionState.Idle,
  ]),
  [ConnectionState.Connected]: new Set<ConnectionState>([
    ConnectionState.Disconnected,
    ConnectionState.Idle,
  ]),
  [ConnectionState.Disconnected]: new Set<ConnectionState>([
    ConnectionState.Signaling,
    ConnectionState.Idle,
  ]),
};

export class InvalidTransitionError extends Error {
  public readonly from: ConnectionState;
  public readonly to: ConnectionState;

  public constructor(from: ConnectionState, to: ConnectionState) {
    super(`Invalid connection transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class ConnectionStateMachine {
  private state: ConnectionState = ConnectionState.Idle;

  public getState(): ConnectionState {
    return this.state;
  }

  public transition(next: ConnectionState): void {
    if (!CONNECTION_STATE_VALUES.has(next)) {
      throw new InvalidTransitionError(this.state, next);
    }
    if (next === ConnectionState.Idle) {
      this.state = ConnectionState.Idle;
      return;
    }
    const allowed = TRANSITIONS[this.state];
    if (!allowed.has(next)) {
      throw new InvalidTransitionError(this.state, next);
    }
    this.state = next;
  }
}

export type GlareOutcome = "keep" | "rollback";

export function isPolite(role: Role): boolean {
  return role === Role.Responder;
}

export function resolveGlare(role: Role): GlareOutcome {
  return role === Role.Initiator ? "keep" : "rollback";
}

export type RemoteOfferOutcome = "answer" | "ignore";

export class GlareResolver {
  private readonly role: Role;
  private offerInFlight = false;

  public constructor(role: Role) {
    this.role = role;
  }

  public beginOffer(): void {
    this.offerInFlight = true;
  }

  public endOffer(): void {
    this.offerInFlight = false;
  }

  public onRemoteOffer(): RemoteOfferOutcome {
    if (!this.offerInFlight) {
      return "answer";
    }
    return isPolite(this.role) ? "answer" : "ignore";
  }
}

/**
 * R7/F5: derive a glare role from the LOCAL identity key alone, for callers
 * that have not yet seen the peer (the orchestrator's internal-signaling
 * path derives its role at broker-connect time, before any peer identity is
 * pinned). The rule is deterministic and stable across reconnects for the
 * same identity: an even-parity first key byte yields Initiator, an
 * odd-parity byte yields Responder. Both peers apply the same rule, so a
 * pair with different-parity keys (the common case under uniform P-256
 * public keys) gets one Initiator and one Responder, making glare resolvable
 * via {@link GlareResolver} instead of both sides impolite.
 *
 * SEC1 uncompressed public keys always start with 0x04 (the prefix byte); the
 * first key byte (X coordinate) is used instead so the parity actually varies
 * across identities.
 */
export function deriveGlareRole(localIdentityKey: Uint8Array): Role {
  return isEvenParityKey(localIdentityKey) ? Role.Initiator : Role.Responder;
}

/**
 * R3F4 (Phase 8): derive the resume glare role from BOTH identity keys. A
 * resumed conversation has the peer's key pinned (TOFU), and the frozen
 * protocol (§3, protocol-v1.md) already fixes the two-key rule: encode both
 * identity public keys as 65-byte uncompressed SEC1 and compare the byte
 * strings lexicographically — the SMALLER key is the Initiator, which §3
 * also names the impolite peer under glare. Delegating to {@link deriveRole}
 * keeps the resume path on the same frozen rule as the wire-protocol role
 * derivation, so the two can never disagree about who is initiator.
 *
 * Both resuming peers hold the same key pair (their own key + the peer's
 * pinned key), so each computes the same ordering and lands on the OPPOSITE
 * role — a simultaneous rejoin resolves glare deterministically instead of
 * deadlocking with two impolite peers.
 *
 * Identical keys are §3's RoleIndeterminable case — the peer key equals the
 * local one, i.e. a device pinned its OWN key as the peer's — which the
 * frozen protocol declares a fatal error; it cannot arise between two
 * distinct TOFU-pinned identities. The derivation still owes every caller a
 * role, and under role-independent origination NO fail-safe choice
 * converges: Responder-on-both (returned here) makes both sides polite, yet
 * the seated side still offers, so a sequential rejoin ends in crossed
 * answers (each side rolls its own offer back and answers the other's) and
 * stalls; the opposite choice, Initiator-on-both, stalls via two impolite
 * peers mutually ignoring each other's offers. Either stall is silent — no
 * crash, no signaling storm, no unhandled rejection — the safest behavior
 * available for an input the protocol already rules unrecoverable. Distinct
 * keys (every real pair) always converge: simultaneous rejoins serialize at
 * the broker (the second join is what notifies the seated first), and the
 * lexicographic rule then breaks the glare symmetry exactly one way.
 */
export function deriveResumeGlareRole(
  localIdentityKey: PublicKey,
  peerIdentityKey: PublicKey,
): Role {
  if (compareUint8Arrays(localIdentityKey, peerIdentityKey) === 0) {
    return Role.Responder;
  }
  return deriveRole(localIdentityKey, peerIdentityKey);
}

/** Even parity of the first key byte (the X coordinate; 0x04 prefix skipped). */
function isEvenParityKey(key: Uint8Array): boolean {
  const parityByte = key[1] ?? 0;
  return (parityByte & 0x01) === 0;
}

/** Byte-wise lexicographic comparison; sign mirrors `a - b` at the first difference. */
function compareUint8Arrays(a: Uint8Array, b: Uint8Array): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    const da = a[i]!;
    const db = b[i]!;
    if (da !== db) return da - db;
  }
  return a.length - b.length;
}
