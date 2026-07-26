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

export type JoinRejectionReason = "malformed" | "full";

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

const MAX_PEERS_PER_ROOM = 2;

export class RoomRegistry {
  private readonly rooms = new Map<string, Set<BrokerSocket>>();

  join(roomId: string, socket: BrokerSocket): JoinResult {
    if (!isValidRoomId(roomId)) {
      return REJECTED_MALFORMED;
    }
    let room = this.rooms.get(roomId);
    if (room === undefined) {
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
