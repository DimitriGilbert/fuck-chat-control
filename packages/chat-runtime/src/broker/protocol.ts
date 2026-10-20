import { isValidPeerId, isValidRoomId, type BrokerSocket, type RoomMode } from "./room-registry";

const TYPE_TAG = "t" as const;

export type BrokerMessageType = "join" | "offer" | "answer" | "ice" | "leave";

/**
 * protocol-v2-group §2.1: `join` gains optional `mode` (absent/"pair" = the
 * legacy pair room) and `peerId` — required iff `mode` is `"group"`, absent
 * otherwise. On the broker→client direction a `join` notification carries
 * `peerId` naming the member that just seated.
 */
export interface JoinMessage {
  readonly kind: "join";
  readonly roomId: string;
  readonly mode?: RoomMode;
  readonly peerId?: string;
}

export interface LeaveMessage {
  readonly kind: "leave";
  readonly roomId: string;
  /** Broker→client only: the departing member's peerId (group rooms). */
  readonly peerId?: string;
}

export interface OfferMessage {
  readonly kind: "offer";
  readonly sdp: unknown;
  /** Client→broker: target member's peerId (required in group rooms). */
  readonly to?: string;
  /** Broker→client: sender's peerId, attached by the relay (group rooms). */
  readonly from?: string;
}

export interface AnswerMessage {
  readonly kind: "answer";
  readonly sdp: unknown;
  readonly to?: string;
  readonly from?: string;
}

export interface IceMessage {
  readonly kind: "ice";
  readonly candidate: unknown;
  readonly to?: string;
  readonly from?: string;
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

/**
 * Read an optional peerId-shaped field (`to`, `from`, `peerId`). Returns the
 * string when present and well-formed, `undefined` when absent, and `null`
 * when present but malformed — so callers can distinguish "absent" from
 * "invalid" and reject the whole message on the latter.
 */
function readPeerIdField(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !isValidPeerId(value)) {
    return null;
  }
  return value;
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
    case "join": {
      const roomId = parsed["roomId"];
      if (typeof roomId !== "string" || !isValidRoomId(roomId)) {
        return null;
      }
      const rawMode = parsed["mode"];
      let mode: RoomMode | undefined;
      if (rawMode === "pair" || rawMode === "group") {
        mode = rawMode;
      } else if (rawMode !== undefined) {
        return null;
      }
      const peerId = readPeerIdField(parsed["peerId"]);
      if (peerId === null) {
        return null;
      }
      // §2.1: peerId is required iff mode is "group" and must not appear in
      // pair mode — anything else is a malformed join.
      if (mode === "group" && peerId === undefined) {
        return null;
      }
      if (mode !== "group" && peerId !== undefined) {
        return null;
      }
      return {
        kind: "join",
        roomId,
        ...(mode !== undefined ? { mode } : {}),
        ...(peerId !== undefined ? { peerId } : {}),
      };
    }
    case "leave": {
      const roomId = parsed["roomId"];
      if (typeof roomId !== "string" || !isValidRoomId(roomId)) {
        return null;
      }
      const peerId = readPeerIdField(parsed["peerId"]);
      if (peerId === null) {
        return null;
      }
      return {
        kind: "leave",
        roomId,
        ...(peerId !== undefined ? { peerId } : {}),
      };
    }
    case "offer":
    case "answer": {
      const sdp = parsed["sdp"];
      if (sdp === undefined) {
        return null;
      }
      const to = readPeerIdField(parsed["to"]);
      const from = readPeerIdField(parsed["from"]);
      if (to === null || from === null) {
        return null;
      }
      return {
        kind: tag,
        sdp,
        ...(to !== undefined ? { to } : {}),
        ...(from !== undefined ? { from } : {}),
      };
    }
    case "ice": {
      const candidate = parsed["candidate"];
      if (candidate === undefined) {
        return null;
      }
      const to = readPeerIdField(parsed["to"]);
      const from = readPeerIdField(parsed["from"]);
      if (to === null || from === null) {
        return null;
      }
      return {
        kind: "ice",
        candidate,
        ...(to !== undefined ? { to } : {}),
        ...(from !== undefined ? { from } : {}),
      };
    }
    default:
      return null;
  }
}

export function formatMessage(message: BrokerMessage): string {
  let raw: Record<string, unknown>;
  switch (message.kind) {
    case "join":
      raw = { [TYPE_TAG]: message.kind, roomId: message.roomId };
      if (message.mode !== undefined) {
        raw["mode"] = message.mode;
      }
      if (message.peerId !== undefined) {
        raw["peerId"] = message.peerId;
      }
      break;
    case "leave":
      raw = { [TYPE_TAG]: message.kind, roomId: message.roomId };
      if (message.peerId !== undefined) {
        raw["peerId"] = message.peerId;
      }
      break;
    case "offer":
    case "answer":
      raw = { [TYPE_TAG]: message.kind, sdp: message.sdp };
      if (message.to !== undefined) {
        raw["to"] = message.to;
      }
      if (message.from !== undefined) {
        raw["from"] = message.from;
      }
      break;
    case "ice":
      raw = { [TYPE_TAG]: message.kind, candidate: message.candidate };
      if (message.to !== undefined) {
        raw["to"] = message.to;
      }
      if (message.from !== undefined) {
        raw["from"] = message.from;
      }
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
