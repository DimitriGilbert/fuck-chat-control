import { Role } from "../protocol/types";

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
