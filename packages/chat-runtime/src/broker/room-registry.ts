import { CONVERSATION_ID_BYTES } from "../protocol/limits";

const ROOM_ID_HEX_LENGTH = CONVERSATION_ID_BYTES * 2;
const ROOM_ID_PATTERN = new RegExp(`^[0-9a-f]{${ROOM_ID_HEX_LENGTH}}$`);

export interface BrokerSocket {
  /**
   * WebSocket ready state. Mirrors the standard values: 0=CONNECTING,
   * 1=OPEN, 2=CLOSING, 3=CLOSED. The zombie sweep treats `> 1` as a dead
   * socket that the runtime failed to deliver an `onClose` for.
   */
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type JoinRejectionReason = "malformed" | "full" | "too_many_rooms";

export interface JoinResult {
  readonly joined: boolean;
  readonly isSecondPeer: boolean;
  readonly reason?: JoinRejectionReason;
}

export function isValidRoomId(roomId: string): boolean {
  return ROOM_ID_PATTERN.test(roomId);
}

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
 * Options for {@link RoomRegistry}. All fields default to the module-level
 * constants and exist so tests can exercise the caps without filling 1024
 * rooms / 2048 connections — the defaults are not injectable at runtime in
 * production by design (the broker runs with a single process-wide registry).
 */
export interface RoomRegistryOptions {
  /** Maximum number of concurrently-live rooms. Defaults to {@link MAX_ROOMS}. */
  readonly maxRooms?: number;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Set<BrokerSocket>>();
  private readonly maxRooms: number;

  public constructor(options: RoomRegistryOptions = {}) {
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
  }

  join(roomId: string, socket: BrokerSocket): JoinResult {
    if (!isValidRoomId(roomId)) {
      return REJECTED_MALFORMED;
    }
    let room = this.rooms.get(roomId);
    if (room === undefined) {
      // R3/F2: gate ONLY the create path. Joining an existing room is always
      // allowed (it neither grows `rooms` nor can be used to bloat memory
      // beyond MAX_PEERS_PER_ROOM per room), so the cap rejects a room that
      // would be CREATED here, not one that already exists.
      if (this.rooms.size >= this.maxRooms) {
        socket.close(1013, "too many rooms");
        return REJECTED_TOO_MANY_ROOMS;
      }
      room = new Set<BrokerSocket>();
      this.rooms.set(roomId, room);
    }
    if (room.size >= MAX_PEERS_PER_ROOM) {
      socket.close(1013, "room full");
      return REJECTED_FULL;
    }
    room.add(socket);
    return { joined: true, isSecondPeer: room.size === MAX_PEERS_PER_ROOM };
  }

  leave(roomId: string, socket: BrokerSocket): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      return;
    }
    room.delete(socket);
    if (room.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  removeSocket(socket: BrokerSocket): void {
    for (const [roomId, room] of this.rooms) {
      if (room.delete(socket) && room.size === 0) {
        this.rooms.delete(roomId);
      }
    }
  }

  getPeer(roomId: string, socket: BrokerSocket): BrokerSocket | null {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      return null;
    }
    for (const peer of room) {
      if (peer !== socket) {
        return peer;
      }
    }
    return null;
  }

  has(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  peerCount(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  size(): number {
    return this.rooms.size;
  }
}
