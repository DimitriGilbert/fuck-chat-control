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
  peer.send(formatMessage(message));
}
