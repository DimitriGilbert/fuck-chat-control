import { afterEach, describe, expect, it } from "vitest";

import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { Role } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { WebRtcBridge } from "@fuck-eu-chat-control/chat-runtime/runtime/webrtc-bridge";
import { WebRtcAdapter } from "@/features/chat/signaling/webrtc-adapter";

import { MockSignalingSocket, parse } from "./_helpers";

/**
 * R3F5 (Phase 8): the glare resolver's in-flight flag must be armed at offer
 * INITIATION — synchronously at the top of the bridge's initiateOffer — not
 * at send time. This fake parks `createOffer` on a manually-released promise
 * so a test can deliver a colliding remote offer exactly inside the window
 * between initiateOffer's start and sendOffer, which is the window the
 * verifier identified as the bug's reach.
 */
class GatedRtcPeerConnection {
  public connectionState: RTCPeerConnectionState = "new";
  public remoteDescription: RTCSessionDescription | null = null;
  public localDescription: RTCSessionDescription | null = null;
  public rollbackCount = 0;
  public readonly localDescTypes: string[] = [];
  public closed = false;
  private readonly offerWaiters: Array<(desc: RTCSessionDescriptionInit) => void> = [];

  public addEventListener(_type: string, _fn: (event: unknown) => void): void {
    // The bridge subscribes to icecandidate / connectionstatechange /
    // datachannel; these tests do not drive any of them.
  }

  /** Park the caller until the test releases the gate. */
  public createOffer(): Promise<RTCSessionDescriptionInit> {
    return new Promise<RTCSessionDescriptionInit>((resolve) => {
      this.offerWaiters.push(resolve);
    });
  }

  /** Release one parked createOffer with a canned local offer. */
  public releaseOffer(): void {
    const waiter = this.offerWaiters.shift();
    waiter?.({ type: "offer", sdp: "gated-offer-sdp" });
  }

  public async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "fake-answer-sdp" };
  }

  public async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescTypes.push(desc.type);
    if (desc.type === "rollback") {
      this.rollbackCount++;
      this.localDescription = null;
      return;
    }
    this.localDescription = desc as unknown as RTCSessionDescription;
  }

  public async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc as unknown as RTCSessionDescription;
  }

  public async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {
    // No-op for these tests.
  }

  public createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label);
  }

  public close(): void {
    this.closed = true;
  }
}

/** Minimal RTCDataChannel double (surface the adapter touches). */
class FakeDataChannel {
  public readonly label: string;
  public readyState: RTCDataChannelState = "connecting";
  public binaryType: BinaryType = "arraybuffer";
  public bufferedAmountLowThreshold = 0;

  public constructor(label: string) {
    this.label = label;
  }

  public addEventListener(_type: string, _fn: (event: unknown) => void): void {
    // No-op: no channel events are driven here.
  }

  public send(_bytes: Uint8Array): void {
    // No-op
  }

  public close(): void {
    this.readyState = "closed";
  }
}

const originalRtc = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;

function installGatedRtc(): GatedRtcPeerConnection {
  const instance = new GatedRtcPeerConnection();
  (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = function () {
    return instance;
  };
  return instance;
}

function restoreRtc(): void {
  if (originalRtc === undefined) {
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  } else {
    (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = originalRtc;
  }
}

afterEach(() => {
  restoreRtc();
});

function deterministicConversationId(seed: number): ConversationId {
  const bytes = new Uint8Array(CONVERSATION_ID_BYTES);
  for (let i = 0; i < CONVERSATION_ID_BYTES; i++) bytes[i] = (seed * 31 + i) & 0xff;
  return encodeConversationId(bytes);
}

function roomHex(roomId: ConversationId): string {
  let hex = "";
  for (let i = 0; i < roomId.length; i++) {
    hex += roomId[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** Deliver a wire message (offer/answer/join/leave) as if from the broker. */
function deliver(socket: MockSignalingSocket, payload: unknown): void {
  socket.deliver(JSON.stringify(payload));
}

function countKind(socket: MockSignalingSocket, kind: string): number {
  return socket.sent.filter((raw) => parse(raw).t === kind).length;
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve));
}

describe("R3F5: glare flag armed at offer initiation (not send time)", () => {
  it("impolite peer IGNORES a remote offer arriving during initiateOffer's awaits — no rollback, no answer", async () => {
    const fakePc = installGatedRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(71);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      // Initiator is the impolite peer per isPolite().
      role: Role.Initiator,
      socketFactory: () => socket,
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: () => {
        // not exercised
      },
    });
    bridge.start();
    socket.serverOpen();

    // Peer joins → initiateOffer starts and PARKS inside createOffer. This
    // is the window between initiation and send where the resolver's flag
    // used to still be unarmed.
    deliver(socket, { t: "join", roomId: roomHex(roomId) });
    await flush();
    expect(fakePc.localDescTypes).not.toContain("offer");

    // The colliding remote offer arrives inside the window. With the flag
    // armed at initiation the resolver returns "ignore" for the impolite
    // peer; pre-fix it returned "answer" (flag still false) and the bridge
    // performed the polite-side rollback + answer.
    deliver(socket, { t: "offer", sdp: { type: "offer", sdp: "colliding" } });
    await flush();

    expect(fakePc.remoteDescription).toBeNull();
    expect(fakePc.rollbackCount).toBe(0);
    expect(countKind(socket, "answer")).toBe(0);

    // Release the parked offer: the impolite side KEEPS its own offer and
    // transmits it (exactly one offer on the wire).
    fakePc.releaseOffer();
    await flush();
    expect(fakePc.localDescTypes).toContain("offer");
    expect(fakePc.rollbackCount).toBe(0);
    expect(countKind(socket, "offer")).toBe(1);
    expect(countKind(socket, "answer")).toBe(0);

    bridge.close();
  });

  it("polite peer answering mid-window supersedes the parked local offer — no stale second offer is transmitted", async () => {
    const fakePc = installGatedRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(72);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      // Responder is the polite peer per isPolite().
      role: Role.Responder,
      socketFactory: () => socket,
      iceServers: [],
      peerConnectionFactory: (opts) => new WebRtcAdapter(opts),
      transportReady: () => {
        // not exercised
      },
    });
    bridge.start();
    socket.serverOpen();

    // Drive the real initiateOffer path directly so the test controls when
    // the parked createOffer resolves (any notified side may originate —
    // handlePeerJoin does not gate on role). It parks inside createOffer
    // with the glare flag armed at initiation.
    const internal = bridge as unknown as { initiateOffer(): Promise<void> };
    void internal.initiateOffer();
    await flush();
    expect(fakePc.localDescTypes).not.toContain("offer");

    // Remote offer arrives mid-window: the polite side rolls back its
    // nascent offer and answers.
    deliver(socket, { t: "offer", sdp: { type: "offer", sdp: "colliding" } });
    await flush();
    expect(fakePc.rollbackCount).toBe(1);
    expect(fakePc.remoteDescription?.type).toBe("offer");
    expect(countKind(socket, "answer")).toBe(1);

    // Releasing the parked createOffer must NOT push the now-stale offer:
    // initiateOffer re-checks its in-flight flag after each await and
    // abandons the superseded offer instead of transmitting a second offer
    // on top of the completed exchange.
    fakePc.releaseOffer();
    await flush();
    expect(fakePc.localDescTypes).not.toContain("offer");
    expect(countKind(socket, "offer")).toBe(0);
    expect(countKind(socket, "answer")).toBe(1);

    bridge.close();
  });
});
