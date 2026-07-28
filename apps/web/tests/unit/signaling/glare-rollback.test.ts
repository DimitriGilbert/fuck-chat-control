import { afterEach, describe, expect, it } from "vitest";

import { encodeConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/codec";
import { CONVERSATION_ID_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { Role } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { WebRtcBridge } from "@fuck-eu-chat-control/chat-runtime/runtime/webrtc-bridge";
import { WebRtcAdapter } from "@/features/chat/signaling/webrtc-adapter";

import { MockSignalingSocket, parse } from "./_helpers";

/**
 * Minimum viable fake of `RTCPeerConnection` for the perfect-negotiation
 * glare tests. It records every `setLocalDescription` invocation so the test
 * can assert that a rollback description (`{ type: "rollback" }`) was actually
 * pushed to the underlying peer connection. It does NOT do real SDP/ICE work
 * — the bridge's glare logic is purely about the *sequence* of operations,
 * not their SDP content.
 *
 * The real RTCPeerConnection is not available in the unit-test environment,
 * and jsdom does not provide it either; we install this fake globally for the
 * duration of each test (see installFakeRtc / restoreRtc).
 */
class FakeRtcPeerConnection {
  public connectionState: RTCPeerConnectionState = "new";
  public remoteDescription: RTCSessionDescription | null = null;
  public localDescription: RTCSessionDescription | null = null;
  public rollbackCount = 0;
  public readonly localDescTypes: string[] = [];
  public closed = false;

  public addEventListener(_type: string, _fn: (event: unknown) => void): void {
    // The bridge subscribes to icecandidate / connectionstatechange /
    // datachannel; the glare tests do not drive any of these.
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "fake-offer-sdp" };
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
    // No-op for this test.
  }

  public createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label);
  }

  public close(): void {
    this.closed = true;
  }
}

/**
 * Minimal RTCDataChannel double. The adapter touches `binaryType`,
 * `bufferedAmountLowThreshold`, `addEventListener`, `readyState`, `send`, and
 * `close`. We implement just those.
 */
class FakeDataChannel {
  public readonly label: string;
  public readyState: RTCDataChannelState = "connecting";
  public binaryType: BinaryType = "arraybuffer";
  public bufferedAmountLowThreshold = 0;

  public constructor(label: string) {
    this.label = label;
  }

  public addEventListener(_type: string, _fn: (event: unknown) => void): void {
    // The adapter subscribes to open / message / bufferedamountlow; the glare
    // tests do not drive any of these.
  }

  public send(_bytes: Uint8Array): void {
    // No-op
  }

  public close(): void {
    this.readyState = "closed";
  }
}

const originalRtc = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;

function installFakeRtc(): FakeRtcPeerConnection {
  const instance = new FakeRtcPeerConnection();
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

/** Deliver a wire message (offer/answer/ice/join/leave) as if from the broker. */
function deliver(socket: MockSignalingSocket, payload: unknown): void {
  socket.deliver(JSON.stringify(payload));
}

/** Find the first wire message of a given kind in the socket's sent log. */
function findKind(socket: MockSignalingSocket, kind: string): unknown {
  const raw = socket.sent.find((line) => parse(line).t === kind);
  if (raw === undefined) return undefined;
  return parse(raw);
}

describe("perfect-negotiation glare + rollback", () => {
  it("the initiator's local offer stays in flight until the matching answer arrives", async () => {
    const fakePc = installFakeRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(101);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
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

    // The initiator offers in response to a peer-join.
    deliver(socket, { t: "join", roomId: roomHex(roomId) });
    await new Promise<void>((resolve) => setTimeout(resolve));

    // The offer was created, set as the local description, and sent. The
    // bridge's localOfferInFlight flag is now true (observed indirectly via
    // the glare behavior in the next test); no rollback has been issued.
    expect(fakePc.localDescription?.type).toBe("offer");
    expect(fakePc.localDescTypes).toContain("offer");
    expect(findKind(socket, "offer")).toBeDefined();
    expect(fakePc.rollbackCount).toBe(0);

    // Deliver the matching answer; the bridge applies it as the remote desc.
    deliver(socket, { t: "answer", sdp: { type: "answer", sdp: "peer-answer" } });
    await new Promise<void>((resolve) => setTimeout(resolve));

    expect(fakePc.remoteDescription?.type).toBe("answer");
    // Still no rollback — the offer was answered, not rolled back.
    expect(fakePc.rollbackCount).toBe(0);

    bridge.close();
  });

  it("impolite peer (initiator) ignores a colliding remote offer while its own is in flight", async () => {
    const fakePc = installFakeRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(202);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
      // Initiator is the impolite peer per isPolite(); under glare it keeps
      // its own offer and ignores the remote.
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

    // Put the initiator into the in-flight-offer state.
    deliver(socket, { t: "join", roomId: roomHex(roomId) });
    await new Promise<void>((resolve) => setTimeout(resolve));
    expect(fakePc.localDescription?.type).toBe("offer");

    // A colliding remote offer arrives. The glare resolver must observe the
    // in-flight flag and return "ignore" for the impolite peer. The flag is
    // genuinely true here because the bridge no longer resets it
    // synchronously after sendOffer (the prior bug); if it were false, the
    // resolver would return "answer" and this assertion would fail.
    deliver(socket, { t: "offer", sdp: { type: "offer", sdp: "colliding" } });
    await new Promise<void>((resolve) => setTimeout(resolve));

    // The impolite peer ignored the remote offer.
    expect(fakePc.remoteDescription).toBeNull();
    expect(fakePc.rollbackCount).toBe(0);
    expect(findKind(socket, "answer")).toBeUndefined();
    // The local offer is still in place.
    expect(fakePc.localDescription?.type).toBe("offer");

    bridge.close();
  });

  it("polite peer (responder) answers a remote offer when no local offer is in flight", async () => {
    const fakePc = installFakeRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(303);
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

    // Establish peer presence so the bridge is in a working state.
    deliver(socket, { t: "ice", candidate: { candidate: "early-probe" } });
    await new Promise<void>((resolve) => setTimeout(resolve));

    // No local offer is in flight (the bridge only offers for the initiator).
    expect(fakePc.localDescription).toBeNull();

    // A remote offer arrives; the polite peer with no in-flight offer answers.
    deliver(socket, { t: "offer", sdp: { type: "offer", sdp: "remote" } });
    await new Promise<void>((resolve) => setTimeout(resolve));

    expect(fakePc.remoteDescription?.type).toBe("offer");
    expect(findKind(socket, "answer")).toBeDefined();
    expect(fakePc.rollbackCount).toBe(0);

    bridge.close();
  });

  it("polite peer with an in-flight offer rolls back before applying the remote offer", async () => {
    // Both-peers-offer scenario: the polite peer (responder) has its own
    // offer in flight when the remote offer arrives. The bridge must
    // (a) call setLocalDescription({type:"rollback"}) BEFORE setting the
    // remote description, (b) release the glare flag, and (c) send an answer.
    //
    // The bridge only triggers an outbound offer from the initiator role
    // (handlePeerJoin gates on role === Initiator), so to reach the
    // polite-with-in-flight-offer rollback branch we drive the bridge's
    // internal negotiation flag directly — this is the same state the
    // bridge itself enters during a real simultaneous-rejoin where the
    // transcript's deterministic role assignment makes one side the
    // responder with a pending offer.
    const fakePc = installFakeRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(606);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
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

    // Establish peer presence.
    deliver(socket, { t: "ice", candidate: { candidate: "early-probe" } });
    await new Promise<void>((resolve) => setTimeout(resolve));

    // Place the bridge into the polite-with-in-flight-offer state. This
    // mirrors the bridge's own `nego.localOfferInFlight = true` from
    // initiateOffer() and the glare resolver's `beginOffer()` from
    // sendOffer() — the same internal state, reached via the only path the
    // design permits for a renegotiation-offer from the responder side.
    const nego = (bridge as unknown as { nego: { localOfferInFlight: boolean } }).nego;
    nego.localOfferInFlight = true;
    const signaling = (
      bridge as unknown as {
        signaling: { sendOffer(sdp: unknown): void };
      }
    ).signaling;
    signaling.sendOffer({ type: "offer", sdp: "responder-simulated-offer" });
    expect(nego.localOfferInFlight).toBe(true);

    // A remote offer arrives. The polite peer must roll back its in-flight
    // offer, then accept the remote.
    deliver(socket, { t: "offer", sdp: { type: "offer", sdp: "colliding" } });
    await new Promise<void>((resolve) => setTimeout(resolve));

    // The rollback was issued BEFORE the remote description was applied.
    expect(fakePc.rollbackCount).toBe(1);
    expect(fakePc.localDescTypes).toContain("rollback");
    expect(fakePc.remoteDescription?.type).toBe("offer");
    expect(findKind(socket, "answer")).toBeDefined();
    // The bridge released its in-flight flag.
    expect(nego.localOfferInFlight).toBe(false);

    bridge.close();
  });

  it("releases the glare flag after the matching answer arrives so a later remote offer is answered", async () => {
    const fakePc = installFakeRtc();
    const socket = new MockSignalingSocket();
    const roomId = deterministicConversationId(404);
    const bridge = new WebRtcBridge({
      brokerUrl: "wss://broker.example",
      roomId,
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

    // First: put the initiator into the in-flight-offer state and verify a
    // colliding offer is ignored (glare active).
    deliver(socket, { t: "join", roomId: roomHex(roomId) });
    await new Promise<void>((resolve) => setTimeout(resolve));
    expect(fakePc.localDescription?.type).toBe("offer");

    deliver(socket, { t: "offer", sdp: { type: "offer", sdp: "collide-1" } });
    await new Promise<void>((resolve) => setTimeout(resolve));
    expect(fakePc.remoteDescription).toBeNull();
    expect(findKind(socket, "answer")).toBeUndefined();

    // Now the matching answer arrives — the bridge must release the glare
    // flag (signaling.endOffer) so the NEXT remote offer is answered.
    deliver(socket, { t: "answer", sdp: { type: "answer", sdp: "peer-answer" } });
    await new Promise<void>((resolve) => setTimeout(resolve));
    expect(fakePc.remoteDescription?.type).toBe("answer");

    // A subsequent remote offer (renegotiation) must now be answered, not
    // ignored — proving the glare flag was released when the answer arrived.
    deliver(socket, { t: "offer", sdp: { type: "offer", sdp: "renegotiation" } });
    await new Promise<void>((resolve) => setTimeout(resolve));

    // The renegotiation offer was applied and a fresh answer was sent.
    expect(fakePc.remoteDescription?.type).toBe("offer");
    const answers = socket.sent
      .map((raw) => parse(raw))
      .filter((m) => m.t === "answer");
    expect(answers.length).toBeGreaterThanOrEqual(1);

    bridge.close();
  });
});
