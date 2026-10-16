import { isValidRoomId, type BrokerSocket } from "./room-registry";

const TYPE_TAG = "t" as const;

export type BrokerMessageType = "join" | "offer" | "answer" | "ice" | "leave";

export interface JoinMessage {
  readonly kind: "join";
  readonly roomId: string;
}

export interface LeaveMessage {
  readonly kind: "leave";
  readonly roomId: string;
}

export interface OfferMessage {
  readonly kind: "offer";
  readonly sdp: unknown;
}

export interface AnswerMessage {
  readonly kind: "answer";
  readonly sdp: unknown;
}

export interface IceMessage {
  readonly kind: "ice";
  readonly candidate: unknown;
}

export type BrokerMessage = JoinMessage | LeaveMessage | OfferMessage | AnswerMessage | IceMessage;

export const BROKER_MESSAGE_MAX_BYTES = 16384;

/**
 * R4/F1: hard bound on a peer's outbound send backlog, in bytes. A stalled or
 * malicious receiver that stops reading TCP makes `ws.send` buffer frames in
 * the process write queue unboundedly — an attacker holding both seats in a
 * room can then flood ≤{@link BROKER_MESSAGE_MAX_BYTES} frames while the
 * partner never drains, growing broker memory until OOM. When a peer's
 * queued-but-unflushed bytes exceed this bound, {@link forward} closes the
 * socket instead of enqueueing more.
 *
 * 1 MiB bounds the backlog to ~64 max-size frames per peer (plus at most one
 * frame of overshoot, since the check runs before enqueue). The zombie sweep
 * cannot cover this case — the socket stays OPEN and any inbound frame marks
 * it alive — so the bound is enforced on the send path itself.
 */
export const BROKER_MAX_BUFFERED_BYTES = 1024 * 1024;

const RELAYABLE_KINDS: ReadonlySet<BrokerMessage["kind"]> = new Set(["offer", "answer", "ice"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseMessage(raw: string): BrokerMessage | null {
  if (raw.length === 0 || raw.length > BROKER_MESSAGE_MAX_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed)) {
    return null;
  }
  const tag = parsed[TYPE_TAG];
  if (typeof tag !== "string") {
    return null;
  }
  switch (tag) {
    case "join":
    case "leave": {
      const roomId = parsed["roomId"];
      if (typeof roomId !== "string" || !isValidRoomId(roomId)) {
        return null;
      }
      return { kind: tag, roomId };
    }
    case "offer":
    case "answer": {
      const sdp = parsed["sdp"];
      if (sdp === undefined) {
        return null;
      }
      return { kind: tag, sdp };
    }
    case "ice": {
      const candidate = parsed["candidate"];
      if (candidate === undefined) {
        return null;
      }
      return { kind: tag, candidate };
    }
    default:
      return null;
  }
}

export function formatMessage(message: BrokerMessage): string {
  let raw: Record<string, unknown>;
  switch (message.kind) {
    case "join":
    case "leave":
      raw = { [TYPE_TAG]: message.kind, roomId: message.roomId };
      break;
    case "offer":
    case "answer":
      raw = { [TYPE_TAG]: message.kind, sdp: message.sdp };
      break;
    case "ice":
      raw = { [TYPE_TAG]: message.kind, candidate: message.candidate };
      break;
  }
  return JSON.stringify(raw);
}

export function forward(peer: BrokerSocket, message: BrokerMessage): void {
  if (!RELAYABLE_KINDS.has(message.kind)) {
    return;
  }
  // R4/F1: refuse to enqueue onto a peer whose send backlog already exceeds
  // the bound. The socket is still OPEN here — a stalled receiver never
  // transitions readyState, so the zombie sweep cannot see it — so the send
  // path must close it itself. Closing runs the normal close path (crossws
  // `close` hook → cleanup → onClose), which evicts the seat and notifies the
  // partner with a `leave`. 1013 (Try Again Later) matches the overload code
  // used by the room/connection caps.
  if (peer.bufferedAmount > BROKER_MAX_BUFFERED_BYTES) {
    peer.close(1013, "send buffer overflow");
    return;
  }
  peer.send(formatMessage(message));
}
