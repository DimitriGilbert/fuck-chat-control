import { beforeAll, describe, expect, it } from "vitest";

import { generateIdentityKeyPair } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { encodePeerId, GroupError } from "@fuck-eu-chat-control/chat-runtime/group";
import type { PeerId } from "@fuck-eu-chat-control/chat-runtime/group";
import type { PublicKey } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { GroupWebrtcManager } from "@fuck-eu-chat-control/chat-runtime/runtime/group-webrtc-manager";
import type { GroupLinkHost } from "@fuck-eu-chat-control/chat-runtime/runtime/group-webrtc-manager";
import type { PeerTransport } from "@fuck-eu-chat-control/chat-runtime/transport/peer-transport";
import type {
  DataChannelTransport,
  IceCandidate,
  PeerConnection,
  PeerConnectionFactory,
  PeerConnectionFactoryOptions,
  PeerConnectionState,
  SessionDescription,
} from "@fuck-eu-chat-control/chat-runtime/transport/types";

import { MockSignalingSocket, parse } from "../signaling/_helpers";

const ROOM_ID = "00112233445566778899aabbccddeeff";
const OWN_PEER = "ffffffffffffffff"; // lexicographically high: polite vs most peerIds
const PEER_B = encodePeerId("bbbbbbbbbbbbbbbb");
const PEER_C = encodePeerId("cccccccccccccccc");

/**
 * Two real identity keys with a KNOWN lexicographic order — the frozen
 * protocol's role rule makes the smaller key Initiator (impolite under
 * glare) and the larger Responder (polite). Generated once for the file and
 * sorted, so the glare tests pick their scenario by assignment rather than
 * by luck.
 */
let keySmall: PublicKey;
let keyLarge: PublicKey;

beforeAll(async () => {
  const a = await generateIdentityKeyPair();
  const b = await generateIdentityKeyPair();
  const cmp = compareKeys(a.publicKey, b.publicKey);
  if (cmp === 0) throw new Error("generated identical identity keys");
  keySmall = cmp < 0 ? a.publicKey : b.publicKey;
  keyLarge = cmp < 0 ? b.publicKey : a.publicKey;
});

function compareKeys(a: Uint8Array, b: Uint8Array): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

class TestDataChannel implements DataChannelTransport {
  public readonly bufferedAmount = 0;
  public ready = false;
  public closed = false;
  public readonly sentBytes: Uint8Array[] = [];
  private openListener: (() => void) | null = null;

  public send(bytes: Uint8Array): void {
    this.sentBytes.push(bytes);
  }

  public setDrainListener(_listener: (() => void) | null): void {
    // no-op
  }

  public setOnMessage(_handler: ((bytes: Uint8Array) => void) | null): void {
    // no-op
  }

  public onOpen(listener: () => void): void {
    this.openListener = listener;
  }

  public fireOpen(): void {
    this.ready = true;
    this.openListener?.();
  }

  public close(): void {
    this.closed = true;
    this.ready = false;
  }
}

class TestPeerConnection implements PeerConnection {
  public connectionState: PeerConnectionState = "new";
  public closed = false;
  public readonly localDescTypes: string[] = [];
  public readonly remoteDescTypes: string[] = [];
  public readonly createdChannels: TestDataChannel[] = [];
  public readonly addedCandidates: IceCandidate[] = [];
  private readonly handlers: PeerConnectionFactoryOptions;

  public constructor(options: PeerConnectionFactoryOptions) {
    this.handlers = options;
  }

  public createOffer(): Promise<SessionDescription> {
    return Promise.resolve({ type: "offer", sdp: "test-offer-sdp" });
  }

  public createAnswer(): Promise<SessionDescription> {
    return Promise.resolve({ type: "answer", sdp: "test-answer-sdp" });
  }

  public setLocalDescription(description: SessionDescription): Promise<void> {
    this.localDescTypes.push(description.type);
    return Promise.resolve();
  }

  public setRemoteDescription(description: SessionDescription): Promise<void> {
    this.remoteDescTypes.push(description.type);
    return Promise.resolve();
  }

  public addIceCandidate(candidate: IceCandidate): Promise<void> {
    this.addedCandidates.push(candidate);
    return Promise.resolve();
  }

  public createDataChannel(): DataChannelTransport {
    const channel = new TestDataChannel();
    this.createdChannels.push(channel);
    return channel;
  }

  public fireIceCandidate(candidate: IceCandidate): void {
    this.handlers.onIceCandidate?.(candidate);
  }

  public fireDataChannel(channel: DataChannelTransport): void {
    this.handlers.onDataChannel?.(channel);
  }

  public fireConnectionState(state: PeerConnectionState): void {
    this.connectionState = state;
    this.handlers.onConnectionStateChange?.(state);
  }

  public close(): void {
    this.closed = true;
  }
}

interface PcPool {
  readonly factory: PeerConnectionFactory;
  readonly instances: TestPeerConnection[];
}

function testPcFactory(): PcPool {
  const instances: TestPeerConnection[] = [];
  return {
    factory: (options) => {
      const instance = new TestPeerConnection(options);
      instances.push(instance);
      return instance;
    },
    instances,
  };
}

/** Minimal {@link GroupLinkHost} fake recording the session-facing calls. */
class FakeGroupSession implements GroupLinkHost {
  public readonly attached: Array<{ peerId: PeerId; transport: PeerTransport }> = [];
  public readonly dropped: PeerId[] = [];
  public readonly linkIdentities = new Map<string, PublicKey>();
  public leaveCalls = 0;
  public attachError: Error | null = null;
  public readonly onLeave?: () => void;

  public constructor(onLeave?: () => void) {
    this.onLeave = onLeave;
  }

  public attachLinkTransport(peerId: PeerId, transport: PeerTransport): void {
    if (this.attachError !== null) throw this.attachError;
    this.attached.push({ peerId, transport });
  }

  public dropLink(peerId: PeerId): void {
    this.dropped.push(peerId);
    // Faithful to GroupSession: the dropped link takes its authenticated
    // identity with it — linkPeerIdentity is null until a re-attach
    // re-handshakes.
    this.linkIdentities.delete(peerId);
  }

  public linkPeerIdentity(peerId: PeerId): PublicKey | null {
    return this.linkIdentities.get(peerId) ?? null;
  }

  public leave(): void {
    this.leaveCalls++;
    this.onLeave?.();
  }
}

interface ManagerKit {
  readonly manager: GroupWebrtcManager;
  readonly socket: MockSignalingSocket;
  readonly pcs: PcPool;
  readonly session: FakeGroupSession;
  readonly linkStates: Array<{ peerId: PeerId; state: PeerConnectionState }>;
  readonly errors: unknown[];
}

interface ManagerOverrides {
  readonly peerId?: string;
  readonly maxMembers?: number;
  readonly session?: FakeGroupSession;
  readonly localIdentityPublicKey?: PublicKey;
}

function makeManager(overrides: ManagerOverrides = {}): ManagerKit {
  const socket = new MockSignalingSocket();
  const pcs = testPcFactory();
  const session = overrides.session ?? new FakeGroupSession();
  const linkStates: Array<{ peerId: PeerId; state: PeerConnectionState }> = [];
  const errors: unknown[] = [];
  const manager = new GroupWebrtcManager({
    brokerUrl: "ws://broker.example/ws",
    roomId: ROOM_ID,
    peerId: encodePeerId(overrides.peerId ?? OWN_PEER),
    localIdentityPublicKey: overrides.localIdentityPublicKey ?? keySmall,
    session,
    socketFactory: () => socket,
    peerConnectionFactory: pcs.factory,
    iceServers: [],
    maxMembers: overrides.maxMembers,
    onPeerLinkState: (peerId, state) => {
      linkStates.push({ peerId, state });
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return { manager, socket, pcs, session, linkStates, errors };
}

function joinPeer(socket: MockSignalingSocket, peerId: PeerId): void {
  socket.deliver(JSON.stringify({ t: "join", roomId: ROOM_ID, peerId }));
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve));
}

function countKind(socket: MockSignalingSocket, kind: string): number {
  return socket.sent.filter((raw) => parse(raw).t === kind).length;
}

describe("GroupWebrtcManager — connect", () => {
  it("seats a generated peerId in the group room on socket open", () => {
    const socket = new MockSignalingSocket();
    const pcs = testPcFactory();
    const manager = new GroupWebrtcManager({
      brokerUrl: "ws://broker.example/ws",
      roomId: ROOM_ID,
      localIdentityPublicKey: keySmall,
      session: new FakeGroupSession(),
      socketFactory: () => socket,
      peerConnectionFactory: pcs.factory,
    });
    expect(manager.ownPeerId).toMatch(/^[0-9a-f]{16}$/);
    manager.connect();
    socket.serverOpen();
    expect(parse(socket.sent[0])).toEqual({
      t: "join",
      roomId: ROOM_ID,
      mode: "group",
      peerId: manager.ownPeerId,
    });
    manager.leave();
  });

  it("uses the caller-supplied peerId", () => {
    const { manager, socket } = makeManager();
    manager.connect();
    socket.serverOpen();
    expect(parse(socket.sent[0])).toEqual({
      t: "join",
      roomId: ROOM_ID,
      mode: "group",
      peerId: OWN_PEER,
    });
    manager.leave();
  });

  it("a second connect() is a no-op", () => {
    const { manager, socket } = makeManager();
    manager.connect();
    socket.serverOpen();
    manager.connect();
    expect(socket.sent).toHaveLength(1);
    manager.leave();
  });
});

describe("GroupWebrtcManager — offer/answer flow", () => {
  it("onPeerJoin creates a peer connection and sends an addressed offer", async () => {
    const { manager, socket, pcs } = makeManager();
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();

    expect(pcs.instances).toHaveLength(1);
    expect(countKind(socket, "offer")).toBe(1);
    const sent = parse(socket.sent[1]);
    expect(sent.t).toBe("offer");
    expect(sent.to).toBe(PEER_B);
    expect((sent.sdp as SessionDescription).type).toBe("offer");
    manager.leave();
  });

  it("onOffer answers addressed after rolling back the auto-initiated offer (polite pre-identity)", async () => {
    const { manager, socket, pcs } = makeManager();
    manager.connect();
    socket.serverOpen();

    // The inbound offer auto-promotes the peer (onPeerJoin fires first,
    // arming a nascent offer), then the offer itself — own peerId is the
    // larger label so this side is the polite one: it rolls back and
    // answers instead of letting a second offer hit the wire.
    socket.deliver(JSON.stringify({ t: "offer", from: PEER_B, sdp: { type: "offer", sdp: "r" } }));
    await flush();

    const pc = pcs.instances[0];
    expect(pc).toBeDefined();
    expect(pc.localDescTypes).toContain("rollback");
    expect(pc.remoteDescTypes).toEqual(["offer"]);
    expect(countKind(socket, "offer")).toBe(0);
    const answer = socket.sent.map(parse).find((m) => m.t === "answer");
    if (answer === undefined) {
      throw new Error("expected an answer message on the wire");
    }
    expect(answer.to).toBe(PEER_B);
    expect((answer.sdp as SessionDescription).type).toBe("answer");
    manager.leave();
  });

  it("onAnswer applies the remote description and clears the in-flight offer", async () => {
    const { manager, socket, pcs } = makeManager();
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    socket.deliver(
      JSON.stringify({ t: "answer", from: PEER_B, sdp: { type: "answer", sdp: "a" } }),
    );
    await flush();

    expect(pcs.instances[0]?.remoteDescTypes).toEqual(["answer"]);
    manager.leave();
  });

  it("routes ICE both ways per pair: adapter candidates go out addressed; inbound candidates land on the right pc", async () => {
    const { manager, socket, pcs } = makeManager();
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    joinPeer(socket, PEER_C);
    await flush();
    const pcB = pcs.instances[0];
    const pcC = pcs.instances[1];
    expect(pcB).toBeDefined();
    expect(pcC).toBeDefined();

    const outbound: IceCandidate = { candidate: "local-cand", sdpMid: "0" };
    pcC.fireIceCandidate(outbound);
    const ice = socket.sent.map(parse).find((m) => m.t === "ice");
    expect(ice).toBeDefined();
    expect(ice?.to).toBe(PEER_C);
    expect(ice?.candidate).toEqual(outbound);

    const inbound: IceCandidate = { candidate: "remote-cand" };
    socket.deliver(JSON.stringify({ t: "ice", from: PEER_B, candidate: inbound }));
    await flush();
    expect(pcB.addedCandidates).toEqual([inbound]);
    expect(pcC.addedCandidates).toEqual([]);

    // ICE from an unknown peer is dropped silently.
    socket.deliver(JSON.stringify({ t: "ice", from: "dddddddddddddddd", candidate: inbound }));
    await flush();
    expect(pcB.addedCandidates).toHaveLength(1);
    manager.leave();
  });
});

describe("GroupWebrtcManager — data channel → session attach", () => {
  it("attaches the offerer's channel to the session once open + connected", async () => {
    const { manager, socket, pcs, session } = makeManager();
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    const pc = pcs.instances[0];
    const channel = pc?.createdChannels[0];
    expect(pc).toBeDefined();
    expect(channel).toBeDefined();

    channel?.fireOpen();
    pc?.fireConnectionState("connected");

    expect(session.attached).toHaveLength(1);
    expect(session.attached[0]?.peerId).toBe(PEER_B);
    session.attached[0]?.transport.send(new Uint8Array([1, 2, 3]));
    expect(channel?.sentBytes).toHaveLength(1);
    manager.leave();
  });

  it("attaches the responder-side channel delivered via onDataChannel", async () => {
    const { manager, socket, pcs, session } = makeManager();
    manager.connect();
    socket.serverOpen();

    socket.deliver(JSON.stringify({ t: "offer", from: PEER_B, sdp: { type: "offer", sdp: "r" } }));
    await flush();
    const pc = pcs.instances[0];
    expect(pc).toBeDefined();

    const channel = new TestDataChannel();
    pc?.fireDataChannel(channel);
    pc?.fireConnectionState("connected");
    channel.fireOpen();

    expect(session.attached).toHaveLength(1);
    expect(session.attached[0]?.peerId).toBe(PEER_B);
    manager.leave();
  });

  it("tears the pair down and reports the error when the session rejects the attach", async () => {
    const session = new FakeGroupSession();
    session.attachError = new Error("group already holds 7 links");
    const { manager, socket, pcs, errors } = makeManager({ session });
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    const pc = pcs.instances[0];
    const channel = pc?.createdChannels[0];
    channel?.fireOpen();
    pc?.fireConnectionState("connected");

    expect(errors).toHaveLength(1);
    expect(pc?.closed).toBe(true);
    expect(session.dropped).toEqual([PEER_B]);
    expect(manager.peerConnectionCount).toBe(0);
    manager.leave();
  });
});

describe("GroupWebrtcManager — peer leave / turnover / failure", () => {
  it("onPeerLeave closes the pair, drops the session link and reports closed", async () => {
    const { manager, socket, pcs, session, linkStates } = makeManager();
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    const pc = pcs.instances[0];

    socket.deliver(JSON.stringify({ t: "leave", roomId: ROOM_ID, peerId: PEER_B }));
    await flush();

    expect(pc?.closed).toBe(true);
    expect(session.dropped).toEqual([PEER_B]);
    expect(manager.peerConnectionCount).toBe(0);
    expect(linkStates).toContainEqual({ peerId: PEER_B, state: "closed" });

    // Post-leave signaling from that peer is ignored.
    socket.deliver(JSON.stringify({ t: "ice", from: PEER_B, candidate: { candidate: "x" } }));
    await flush();
    manager.leave();
  });

  it("a repeated join for the same peerId rebuilds the pair and re-offers", async () => {
    const { manager, socket, pcs, session } = makeManager();
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    expect(countKind(socket, "offer")).toBe(1);
    const pc1 = pcs.instances[0];

    // Seat turnover: the occupant re-seated under the same label.
    joinPeer(socket, PEER_B);
    await flush();

    expect(pc1?.closed).toBe(true);
    expect(session.dropped).toEqual([PEER_B]);
    expect(pcs.instances).toHaveLength(2);
    expect(countKind(socket, "offer")).toBe(2);
    const secondOffer = socket.sent
      .map(parse)
      .filter((m) => m.t === "offer")
      .at(-1);
    expect(secondOffer?.to).toBe(PEER_B);
    manager.leave();
  });

  it("a terminal connection state on a still-present peer re-signals: the seated side re-offers", async () => {
    const { manager, socket, pcs, session, linkStates } = makeManager();
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    const pc1 = pcs.instances[0];
    expect(pc1).toBeDefined();

    pc1?.fireConnectionState("failed");
    await flush();

    expect(linkStates).toContainEqual({ peerId: PEER_B, state: "failed" });
    expect(pc1?.closed).toBe(true);
    expect(session.dropped).toEqual([PEER_B]);
    expect(pcs.instances).toHaveLength(2);
    // The seated member re-originates exactly one offer.
    expect(countKind(socket, "offer")).toBe(2);
    manager.leave();
  });

  it("a terminal connection state on a pair we did not seat rebuilds but does not re-offer", async () => {
    const { manager, socket, pcs } = makeManager();
    manager.connect();
    socket.serverOpen();

    // Newcomer-side pair: created by the inbound offer.
    socket.deliver(JSON.stringify({ t: "offer", from: PEER_B, sdp: { type: "offer", sdp: "r" } }));
    await flush();
    const pc1 = pcs.instances[0];
    const offersBefore = countKind(socket, "offer");

    pc1?.fireConnectionState("failed");
    await flush();

    expect(pc1?.closed).toBe(true);
    expect(pcs.instances).toHaveLength(2);
    // The seated member owns the re-offer — we wait for it.
    expect(countKind(socket, "offer")).toBe(offersBefore);
    manager.leave();
  });
});

describe("GroupWebrtcManager — identity-derived glare on renegotiation", () => {
  it("impolite (smaller identity key) keeps its in-flight offer and ignores the remote one", async () => {
    const session = new FakeGroupSession();
    session.linkIdentities.set(PEER_B, keyLarge);
    const { manager, socket, pcs } = makeManager({
      session,
      localIdentityPublicKey: keySmall, // < keyLarge → Initiator → impolite
    });
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    expect(countKind(socket, "offer")).toBe(1);
    const pc = pcs.instances[0];

    socket.deliver(JSON.stringify({ t: "offer", from: PEER_B, sdp: { type: "offer", sdp: "r" } }));
    await flush();

    expect(pc?.localDescTypes).not.toContain("rollback");
    expect(pc?.remoteDescTypes).toEqual([]);
    expect(countKind(socket, "answer")).toBe(0);
    manager.leave();
  });

  it("polite (larger identity key) rolls back its in-flight offer and answers", async () => {
    const session = new FakeGroupSession();
    session.linkIdentities.set(PEER_B, keySmall);
    const { manager, socket, pcs } = makeManager({
      session,
      localIdentityPublicKey: keyLarge, // > keySmall → Responder → polite
    });
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    expect(countKind(socket, "offer")).toBe(1);
    const pc = pcs.instances[0];

    socket.deliver(JSON.stringify({ t: "offer", from: PEER_B, sdp: { type: "offer", sdp: "r" } }));
    await flush();

    expect(pc?.localDescTypes).toContain("rollback");
    expect(pc?.remoteDescTypes).toEqual(["offer"]);
    const answer = socket.sent.map(parse).find((m) => m.t === "answer");
    expect(answer?.to).toBe(PEER_B);
    manager.leave();
  });

  it("a re-offer glare after a link reset still resolves impolite/polite by the pinned identity, not the peerId", async () => {
    const session = new FakeGroupSession();
    session.linkIdentities.set(PEER_B, keyLarge);
    const { manager, socket, pcs } = makeManager({
      session,
      localIdentityPublicKey: keySmall, // < keyLarge → Initiator → impolite
    });
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    expect(countKind(socket, "offer")).toBe(1);

    // Seat turnover rebuilds the pair: the manager pins the peer's
    // authenticated identity BEFORE resetLink's dropLink strips it from
    // the session. From here linkPeerIdentity is null — a live lookup
    // could no longer produce the identity, and the peerId fallback would
    // rule this side POLITE (ffff… > bbbb…) and roll the re-offer back.
    joinPeer(socket, PEER_B);
    await flush();
    expect(session.linkPeerIdentity(PEER_B)).toBeNull();
    expect(countKind(socket, "offer")).toBe(2);
    const pc = pcs.instances[1];

    socket.deliver(JSON.stringify({ t: "offer", from: PEER_B, sdp: { type: "offer", sdp: "r" } }));
    await flush();

    // Impolite by identity (keySmall < keyLarge → Initiator): the local
    // re-offer stands and the remote one is ignored.
    expect(pc?.localDescTypes).not.toContain("rollback");
    expect(pc?.remoteDescTypes).toEqual([]);
    expect(countKind(socket, "answer")).toBe(0);
    manager.leave();
  });
});

describe("GroupWebrtcManager — member cap", () => {
  it("ignores joins beyond maxMembers-1 peer connections", async () => {
    const { manager, socket, pcs, errors } = makeManager({ maxMembers: 2 });
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    joinPeer(socket, PEER_C);
    await flush();

    expect(pcs.instances).toHaveLength(1);
    expect(manager.peerConnectionCount).toBe(1);
    expect(countKind(socket, "offer")).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GroupError);
    manager.leave();
  });

  it("ignores inbound offers beyond the cap", async () => {
    const { manager, socket, pcs, errors } = makeManager({ maxMembers: 2 });
    manager.connect();
    socket.serverOpen();

    joinPeer(socket, PEER_B);
    await flush();
    socket.deliver(JSON.stringify({ t: "offer", from: PEER_C, sdp: { type: "offer", sdp: "r" } }));
    await flush();

    // The auto-promotion join for PEER_C is over the cap → no pair, no answer.
    expect(pcs.instances).toHaveLength(1);
    expect(countKind(socket, "answer")).toBe(0);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    manager.leave();
  });
});

describe("GroupWebrtcManager — leave", () => {
  it("leave() runs session.leave, then relays leave to the broker, then closes every pair", async () => {
    const events: string[] = [];
    const socket = new MockSignalingSocket();
    const realSend = socket.send.bind(socket);
    socket.send = (data: string): void => {
      events.push(`send:${parse(data).t}`);
      realSend(data);
    };
    const pcs = testPcFactory();
    const session = new FakeGroupSession(() => {
      events.push("session-leave");
    });
    const manager = new GroupWebrtcManager({
      brokerUrl: "ws://broker.example/ws",
      roomId: ROOM_ID,
      peerId: encodePeerId(OWN_PEER),
      localIdentityPublicKey: keySmall,
      session,
      socketFactory: () => socket,
      peerConnectionFactory: pcs.factory,
      onError: () => {
        events.push("error");
      },
    });
    manager.connect();
    socket.serverOpen();
    joinPeer(socket, PEER_B);
    joinPeer(socket, PEER_C);
    await flush();
    expect(pcs.instances).toHaveLength(2);
    events.length = 0;

    manager.leave();

    // session.leave() must precede the broker `leave` relay and the pair
    // teardowns — its per-link `leave` control frames need the channels open.
    expect(events[0]).toBe("session-leave");
    expect(events[1]).toBe("send:leave");
    expect(session.leaveCalls).toBe(1);
    expect(pcs.instances[0]?.closed).toBe(true);
    expect(pcs.instances[1]?.closed).toBe(true);
    expect(manager.peerConnectionCount).toBe(0);
    expect(socket.closed).toBe(true);

    manager.leave(); // idempotent
    expect(session.leaveCalls).toBe(1);
  });
});
