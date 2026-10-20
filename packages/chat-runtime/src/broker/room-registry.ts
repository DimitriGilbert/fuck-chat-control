import { CONVERSATION_ID_BYTES, DEFAULT_MAX_GROUP_MEMBERS } from "../protocol/limits";

import { BROKER_CLOSE_CODES, BROKER_CLOSE_REASONS, BrokerErrorCode } from "./errors";

const ROOM_ID_HEX_LENGTH = CONVERSATION_ID_BYTES * 2;
const ROOM_ID_PATTERN = new RegExp(`^[0-9a-f]{${ROOM_ID_HEX_LENGTH}}$`);

// protocol-v2-group §1: a peerId is an 8-byte ephemeral signaling label,
// rendered and validated on the wire as 16 lowercase hex chars. It addresses
// a seated socket inside a group room; pair rooms never carry one.
const PEER_ID_HEX_LENGTH = 16;
const PEER_ID_PATTERN = new RegExp(`^[0-9a-f]{${PEER_ID_HEX_LENGTH}}$`);

export interface BrokerSocket {
  /**
   * WebSocket ready state. Mirrors the standard values: 0=CONNECTING,
   * 1=OPEN, 2=CLOSING, 3=CLOSED. The zombie sweep treats `> 1` as a dead
   * socket that the runtime failed to deliver an `onClose` for.
   */
  readonly readyState: number;
  /**
   * Bytes queued for transmission but not yet flushed to the client
   * (WebSocket `bufferedAmount`). The relay path checks this against
   * `BROKER_MAX_BUFFERED_BYTES` before enqueueing — a stalled receiver keeps
   * the socket OPEN, so backpressure cannot be detected via `readyState`.
   * Adapters without a buffer signal must report 0 (never throw), which
   * disables the bound for that adapter.
   */
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * The mode a room was created with (protocol-v2-group §2.2). A join without
 * `mode` (or `mode:"pair"`) creates a pair room — the unchanged v1 two-seat
 * room; `mode:"group"` creates a peerId-keyed room capped at
 * {@link RoomRegistry}'s `maxGroupPeers`. The mode is fixed by the first
 * join and can never change for the life of the room.
 */
export type RoomMode = "pair" | "group";

export type JoinRejectionReason =
  | "malformed"
  | "full"
  | "too_many_rooms"
  | "mode_mismatch"
  | "duplicate_peer_id";

export interface JoinResult {
  readonly joined: boolean;
  readonly isSecondPeer: boolean;
  /**
   * The mode of the room the socket was seated in. Present only on a
   * successful join; the connection layer uses it to pick the correct
   * join-notification shape (peerId-tagged broadcast for group rooms).
   */
  readonly mode?: RoomMode;
  readonly reason?: JoinRejectionReason;
}

export function isValidRoomId(roomId: string): boolean {
  return ROOM_ID_PATTERN.test(roomId);
}

export function isValidPeerId(peerId: string): boolean {
  return PEER_ID_PATTERN.test(peerId);
}

/**
 * Optional addressing/mode fields of a `join` message, mirroring the parsed
 * broker `JoinMessage`. Absent fields mean a legacy pair join.
 */
export interface JoinOptions {
  readonly mode?: RoomMode;
  readonly peerId?: string;
}

/** One seated socket as returned by {@link RoomRegistry.listPeers}. */
export interface SeatedPeer {
  /** The seat's peerId. Present only in group rooms. */
  readonly peerId?: string;
  readonly socket: BrokerSocket;
}

interface PairRoom {
  readonly mode: "pair";
  readonly seats: Set<BrokerSocket>;
}

interface GroupRoom {
  readonly mode: "group";
  readonly seats: Map<string, BrokerSocket>;
}

type Room = PairRoom | GroupRoom;

const REJECTED_MALFORMED: JoinResult = {
  joined: false,
  isSecondPeer: false,
  reason: "malformed",
};

const REJECTED_FULL: JoinResult = {
  joined: false,
  isSecondPeer: false,
  reason: "full",
};

// R3/F2: a NEW room would push the registry past the room cap.
const REJECTED_TOO_MANY_ROOMS: JoinResult = {
  joined: false,
  isSecondPeer: false,
  reason: "too_many_rooms",
};

const REJECTED_MODE_MISMATCH: JoinResult = {
  joined: false,
  isSecondPeer: false,
  reason: "mode_mismatch",
};

const REJECTED_DUPLICATE_PEER_ID: JoinResult = {
  joined: false,
  isSecondPeer: false,
  reason: "duplicate_peer_id",
};

const MAX_PEERS_PER_ROOM = 2;

/**
 * Hard cap on the number of concurrently-live rooms the registry will track.
 * A room exists only while at least one peer is seated, so this bounds the
 * worst-case `rooms` map size (and thus the per-disconnect work and sweep
 * cost) against an attacker who opens thousands of idle one-peer rooms to
 * exhaust memory (R3/F2). Tunable per-deployment via the {@link RoomRegistry}
 * constructor's `maxRooms` option.
 */
export const MAX_ROOMS = 1024;

/**
 * Options for {@link RoomRegistry}. `maxRooms` exists so tests can exercise
 * the cap without filling 1024 rooms / 2048 connections — it is not
 * injectable at runtime in production by design (the broker runs with a
 * single process-wide registry). `maxGroupPeers` IS runtime-injectable: it
 * is the seat cap of a group room, sourced from the `GROUP_MAX_MEMBERS`
 * server env var (protocol-v2-group §7); unset means
 * `DEFAULT_MAX_GROUP_MEMBERS`.
 */
export interface RoomRegistryOptions {
  /** Maximum number of concurrently-live rooms. Defaults to {@link MAX_ROOMS}. */
  readonly maxRooms?: number;
  /**
   * Maximum seats in a group room. Defaults to `DEFAULT_MAX_GROUP_MEMBERS`
   * and is bounded at the env layer by `MAX_GROUP_MEMBERS_HARD` (16).
   */
  readonly maxGroupPeers?: number;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly maxRooms: number;
  private readonly maxGroupPeers: number;

  public constructor(options: RoomRegistryOptions = {}) {
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
    this.maxGroupPeers = options.maxGroupPeers ?? DEFAULT_MAX_GROUP_MEMBERS;
  }

  join(roomId: string, socket: BrokerSocket, options: JoinOptions = {}): JoinResult {
    if (!isValidRoomId(roomId)) {
      return REJECTED_MALFORMED;
    }
    const mode: RoomMode = options.mode === "group" ? "group" : "pair";
    // protocol-v2-group §2.1: peerId is required iff mode is "group" and must
    // not appear in pair mode; on the wire it is exactly 16 lowercase hex
    // chars. Malformed means the whole join is refused (no seat, no room).
    if (mode === "group") {
      if (options.peerId === undefined || !isValidPeerId(options.peerId)) {
        return REJECTED_MALFORMED;
      }
    } else if (options.peerId !== undefined) {
      return REJECTED_MALFORMED;
    }
    let room = this.rooms.get(roomId);
    if (room === undefined) {
      // R3/F2: gate ONLY the create path. Joining an existing room is always
      // allowed (it neither grows `rooms` nor can be used to bloat memory
      // beyond the room's seat cap), so the cap rejects a room that would be
      // CREATED here, not one that already exists.
      if (this.rooms.size >= this.maxRooms) {
        socket.close(1013, "too many rooms");
        return REJECTED_TOO_MANY_ROOMS;
      }
      // The FIRST join fixes the room's mode for its whole life.
      room =
        mode === "group"
          ? { mode: "group", seats: new Map<string, BrokerSocket>() }
          : { mode: "pair", seats: new Set<BrokerSocket>() };
      this.rooms.set(roomId, room);
    }
    if (room.mode !== mode) {
      // §2.2: a group join into a pair room (or vice versa) is a protocol
      // violation — hard-close the offender like the full/too-many-rooms
      // rejections so a non-conforming client does not linger.
      socket.close(
        BROKER_CLOSE_CODES[BrokerErrorCode.RoomModeMismatch],
        BROKER_CLOSE_REASONS[BrokerErrorCode.RoomModeMismatch],
      );
      return REJECTED_MODE_MISMATCH;
    }
    if (room.mode === "group") {
      // mode === "group" was validated above, so peerId is a definite string.
      const peerId = options.peerId;
      if (peerId === undefined) {
        return REJECTED_MALFORMED;
      }
      // §2.1: duplicate peerIds in one room are rejected — a peerId addresses
      // its seat, so a duplicate would make addressed relay ambiguous.
      if (room.seats.has(peerId)) {
        socket.close(
          BROKER_CLOSE_CODES[BrokerErrorCode.DuplicatePeerId],
          BROKER_CLOSE_REASONS[BrokerErrorCode.DuplicatePeerId],
        );
        return REJECTED_DUPLICATE_PEER_ID;
      }
      if (room.seats.size >= this.maxGroupPeers) {
        socket.close(1013, "room full");
        return REJECTED_FULL;
      }
      room.seats.set(peerId, socket);
      // isSecondPeer is a pair-room signal; group joins notify every seated
      // member via the result's `mode` instead.
      return { joined: true, isSecondPeer: false, mode: "group" };
    }
    if (room.seats.size >= MAX_PEERS_PER_ROOM) {
      socket.close(1013, "room full");
      return REJECTED_FULL;
    }
    room.seats.add(socket);
    return { joined: true, isSecondPeer: room.seats.size === MAX_PEERS_PER_ROOM, mode: "pair" };
  }

  leave(roomId: string, socket: BrokerSocket): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      return;
    }
    if (room.mode === "group") {
      for (const [peerId, seated] of room.seats) {
        if (seated === socket) {
          room.seats.delete(peerId);
          break;
        }
      }
    } else {
      room.seats.delete(socket);
    }
    if (room.seats.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  removeSocket(socket: BrokerSocket): void {
    for (const [roomId, room] of this.rooms) {
      if (room.mode === "group") {
        for (const [peerId, seated] of room.seats) {
          if (seated === socket) {
            room.seats.delete(peerId);
            break;
          }
        }
        if (room.seats.size === 0) {
          this.rooms.delete(roomId);
        }
      } else if (room.seats.delete(socket) && room.seats.size === 0) {
        this.rooms.delete(roomId);
      }
    }
  }

  /**
   * Pair-room forwarding target: the single other seat. Returns null for a
   * group room — group relay is addressed and goes through
   * {@link getPeerById}, never through an "other seat" lookup.
   */
  getPeer(roomId: string, socket: BrokerSocket): BrokerSocket | null {
    const room = this.rooms.get(roomId);
    if (room === undefined || room.mode !== "pair") {
      return null;
    }
    for (const peer of room.seats) {
      if (peer !== socket) {
        return peer;
      }
    }
    return null;
  }

  /** Group-room forwarding target: the socket seated under `peerId`. */
  getPeerById(roomId: string, peerId: string): BrokerSocket | null {
    const room = this.rooms.get(roomId);
    if (room === undefined || room.mode !== "group") {
      return null;
    }
    return room.seats.get(peerId) ?? null;
  }

  /**
   * Every seat in the room, optionally excluding one socket. In a group room
   * each entry carries its `peerId`; pair-room entries have no `peerId`.
   */
  listPeers(roomId: string, excludeSocket?: BrokerSocket): SeatedPeer[] {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      return [];
    }
    const peers: SeatedPeer[] = [];
    if (room.mode === "group") {
      for (const [peerId, socket] of room.seats) {
        if (socket !== excludeSocket) {
          peers.push({ peerId, socket });
        }
      }
    } else {
      for (const socket of room.seats) {
        if (socket !== excludeSocket) {
          peers.push({ socket });
        }
      }
    }
    return peers;
  }

  has(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  peerCount(roomId: string): number {
    return this.rooms.get(roomId)?.seats.size ?? 0;
  }

  size(): number {
    return this.rooms.size;
  }
}
