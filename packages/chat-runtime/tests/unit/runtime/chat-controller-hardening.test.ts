import { afterEach, describe, expect, it, vi } from "vitest";

import { generateAtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import type { AtRestKey } from "@fuck-eu-chat-control/chat-runtime/crypto";
import { hexToConversationId } from "@fuck-eu-chat-control/chat-runtime/orchestrator/invitation";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { createAtRestKeyManager } from "@fuck-eu-chat-control/chat-runtime/runtime/at-rest-key-manager";
import {
  createChatController,
  type ChatController,
} from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import { createIdentityManager } from "@fuck-eu-chat-control/chat-runtime/runtime/identity-manager";
import type { ChatFileInput } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import type {
  SignalingSocket,
  SignalingSocketFactory,
} from "@fuck-eu-chat-control/chat-runtime/signaling/signaling-client";
import {
  InMemoryConversationRepository,
  MessageDirection,
} from "@fuck-eu-chat-control/chat-runtime/store";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationRepository,
} from "@fuck-eu-chat-control/chat-runtime/store";
import type { PeerConnectionFactory } from "@fuck-eu-chat-control/chat-runtime/transport/types";

import { bytesEqual, fakeStorage, stubPeerConnectionFactory } from "./_helpers";

import { MockSignalingSocket } from "../signaling/_helpers";
import { linkLoopbackPair, mockSocketFactory } from "../orchestrator/_helpers";

const BASE_URL = "https://app.example";
const BROKER_URL = "wss://broker.example";
const HEX = "abcdef0123456789abcdef0123456789";

/** Resource dials observable from a test: peer connections built, sockets dialed. */
interface DialStats {
  peerConnectionsCreated: number;
  socketsDialed: number;
}

interface Harness {
  readonly controller: ChatController;
  readonly stats: DialStats;
}

const created: ChatController[] = [];

afterEach(() => {
  while (created.length > 0) {
    created.pop()!.dispose();
  }
});

/**
 * Build a controller whose socket/peer-connection factories count every dial
 * (mirrors the lifecycle-races harness). `socketsDialed` counts
 * SignalingSocketFactory invocations — exactly once per bridge.start() that
 * actually dials — and `peerConnectionsCreated` counts wireBridge
 * constructions, so a double-start that would orphan a bridge is directly
 * observable as stats > 1.
 */
async function makeHarness(repository?: ConversationRepository): Promise<Harness> {
  const identityManager = createIdentityManager(fakeStorage());
  await identityManager.ensureLoaded();
  const atRestKeyManager = createAtRestKeyManager(fakeStorage());
  await atRestKeyManager.ensureLoaded();
  const stats: DialStats = { peerConnectionsCreated: 0, socketsDialed: 0 };
  const basePeers = stubPeerConnectionFactory();
  const baseSockets = mockSocketFactory(new MockSignalingSocket());
  const peerConnectionFactory = (options: Parameters<PeerConnectionFactory>[0]) => {
    stats.peerConnectionsCreated += 1;
    return basePeers(options);
  };
  const socketFactory: SignalingSocketFactory = (url: string): SignalingSocket => {
    stats.socketsDialed += 1;
    return baseSockets(url);
  };
  const controller = createChatController({
    brokerUrl: BROKER_URL,
    baseUrl: BASE_URL,
    identityManager,
    atRestKeyManager,
    repositoryFactory: (key: AtRestKey) => new InMemoryConversationRepository(key),
    repository,
    socketFactory,
    peerConnectionFactory,
    iceServers: [],
  });
  created.push(controller);
  return { controller, stats };
}

interface GatedRepository {
  readonly repo: ConversationRepository;
  /** Resolves once the gated method has been entered (the call is parked). */
  readonly entered: Promise<void>;
  /** Let the parked call proceed. */
  release(): void;
}

/**
 * Wraps an in-memory repository and gates one method on a promise the test
 * controls (same pattern as the lifecycle-races suite). Used to park a
 * startSession/performResume at a chosen await so a racing join/resume can
 * land mid-flight — the exact interleavings the R7F3 single-flight maps
 * guard against.
 */
function gatedRepository(
  gated: "createConversation" | "getConversation",
  preloaded?: InMemoryConversationRepository,
): GatedRepository {
  const inner = preloaded ?? new InMemoryConversationRepository(generateAtRestKey());
  let openGate: () => void = () => {};
  let markEntered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const repo: ConversationRepository = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "createConversation" && gated === "createConversation") {
        return async (id: ConversationId, createdAt: number): Promise<ConversationRecord> => {
          markEntered();
          await gate;
          return await target.createConversation(id, createdAt);
        };
      }
      if (prop === "getConversation" && gated === "getConversation") {
        return async (id: ConversationId): Promise<ConversationRecord | null> => {
          markEntered();
          await gate;
          return await target.getConversation(id);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { repo, entered, release: openGate };
}

interface FailableRepository {
  readonly repo: ConversationRepository;
  /** Make the NEXT getMessages call reject with `error`, then behave normally. */
  failNextGetMessages(error: Error): void;
}

/**
 * Wraps an in-memory repository so a test can arm a one-shot getMessages
 * failure. The resume seed hook (`orchestrator.getHistory`) is the only
 * getMessages call on the resume path, so arming between leave and resume
 * makes the seed throw — the R7F5 failure shape (e.g. AtRestLockedError
 * racing lock(), simulated here with a plain marker error).
 */
function failableGetMessagesRepository(): FailableRepository {
  const inner = new InMemoryConversationRepository(generateAtRestKey());
  let pending: Error | null = null;
  const repo: ConversationRepository = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "getMessages") {
        return async (id: ConversationId): Promise<ConversationMessage[]> => {
          const err = pending;
          pending = null;
          if (err !== null) {
            throw err;
          }
          return await target.getMessages(id);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    repo,
    failNextGetMessages(error: Error): void {
      pending = error;
    },
  };
}

/** Hex-encode a ConversationId the way the controller's keyOf does. */
function toHex(id: ConversationId): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function tick(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForConnected(controller: ChatController, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (controller.getState().connectionState === ConnectionState.Connected) return;
    await tick(10);
  }
  throw new Error("timed out waiting for Connected");
}

/**
 * Link two controllers through a loopback transport pair so the real crypto
 * handshake runs without WebRTC (same pattern as file-transfer.test.ts).
 */
async function linkControllers(
  a: ChatController,
  b: ChatController,
): Promise<{ idA: ConversationId; idB: ConversationId }> {
  const { invitation } = await a.startConversation();
  await b.joinConversation(invitation);
  const idA = a.getActiveConversationId() as ConversationId;
  const idB = b.getActiveConversationId() as ConversationId;
  const { a: ta, b: tb } = linkLoopbackPair();
  a.__attachTransportForTest(idA, ta);
  b.__attachTransportForTest(idB, tb);
  await waitForConnected(a);
  await waitForConnected(b);
  return { idA, idB };
}

function makeFile(text: string, name: string): ChatFileInput {
  return { data: new TextEncoder().encode(text), name, mimeType: "text/plain" };
}

describe("chat-controller lifecycle hardening (Phase 5.2)", () => {
  it("R7F3: two concurrent joinConversation(same id) calls build exactly one session", async () => {
    const { controller, stats } = await makeHarness();

    // Both calls run before either's startSession registers; the second must
    // dedupe onto the first's in-flight join instead of double-starting (the
    // two-fragment forms below normalize to the same conversation id).
    const first = controller.joinConversation(`${BASE_URL}#${HEX}`);
    const second = controller.joinConversation(`#${HEX.toUpperCase()}`);
    await Promise.all([first, second]);

    expect(controller.getState().sessions).toHaveLength(1);
    // Exactly one bridge was built and one signaling socket dialed — a second
    // startSession would have orphaned the first session's bridge (a broker
    // room slot leaked forever).
    expect(stats.peerConnectionsCreated).toBe(1);
    expect(stats.socketsDialed).toBe(1);
  });

  it("R7F3: re-joining a live conversation selects it without building a second session", async () => {
    const { controller, stats } = await makeHarness();
    await controller.joinConversation(`${BASE_URL}#${HEX}`);
    const id = controller.getActiveConversationId() as ConversationId;
    const baselinePeers = stats.peerConnectionsCreated;
    const baselineSockets = stats.socketsDialed;

    // Same conversation id via a different fragment form: must hit the
    // live-session select branch, not registerSession.
    await controller.joinConversation(`#${HEX}`);

    expect(controller.getState().sessions).toHaveLength(1);
    const active = controller.getActiveConversationId() as ConversationId;
    expect(bytesEqual(active, id)).toBe(true);
    expect(stats.peerConnectionsCreated).toBe(baselinePeers);
    expect(stats.socketsDialed).toBe(baselineSockets);
  });

  it("R7F3: joinConversation while a resume for the same id is in flight dedupes onto it", async () => {
    const gated = gatedRepository("getConversation");
    const { controller, stats } = await makeHarness(gated.repo);
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    controller.leaveConversation(id);
    const baselinePeers = stats.peerConnectionsCreated;
    const baselineSockets = stats.socketsDialed;

    // Park the resume at its first repository read...
    const resume = controller.resumeConversation(id);
    await gated.entered;
    // ...then join the same conversation mid-flight. The join must await the
    // resume and select the session it installs — not race a second
    // startSession into the same map key.
    const join = controller.joinConversation(`#${toHex(id)}`);
    gated.release();
    await Promise.all([resume, join]);

    expect(controller.getState().sessions).toHaveLength(1);
    expect(stats.peerConnectionsCreated).toBe(baselinePeers + 1);
    expect(stats.socketsDialed).toBe(baselineSockets + 1);
    const active = controller.getActiveConversationId() as ConversationId;
    expect(bytesEqual(active, id)).toBe(true);
  });

  it("R7F3: resumeConversation while a join for the same id is in flight dedupes onto it", async () => {
    const gated = gatedRepository("createConversation");
    const { controller, stats } = await makeHarness(gated.repo);
    const id = hexToConversationId(HEX);

    // Park the join inside orchestrator.join's createConversation write...
    const join = controller.joinConversation(`${BASE_URL}#${HEX}`);
    await gated.entered;
    // ...then resume the same conversation mid-flight. It must await the
    // join and select the installed session rather than start a second one.
    const resume = controller.resumeConversation(id);
    gated.release();
    await Promise.all([join, resume]);

    expect(controller.getState().sessions).toHaveLength(1);
    expect(stats.peerConnectionsCreated).toBe(1);
    expect(stats.socketsDialed).toBe(1);
    const active = controller.getActiveConversationId() as ConversationId;
    expect(bytesEqual(active, id)).toBe(true);
  });

  it("R7F3: a resume deduped onto a landed JOIN produces a SEEDED session", async () => {
    // Pre-seed the inner repo BEFORE wrapping it in the createConversation
    // gate — seeding through the gate would consume the parked-call latch
    // (and `entered`) meant for the join below.
    const inner = new InMemoryConversationRepository(generateAtRestKey());
    const id = hexToConversationId(HEX);
    await inner.createConversation(id, Date.now());
    await inner.appendMessage(id, "persisted hello", MessageDirection.Received, Date.now());
    await inner.markAuthFailed(id);
    const gated = gatedRepository("createConversation", inner);
    const { controller } = await makeHarness(gated.repo);

    // Park a JOIN for the same conversation inside orchestrator.join's
    // createConversation write, then resume mid-flight. The resume dedupes
    // onto the join's session — installed WITHOUT a seed hook — and must
    // seed it (record + history) before adopting it.
    const join = controller.joinConversation(`${BASE_URL}#${HEX}`);
    await gated.entered;
    const resume = controller.resumeConversation(id);
    gated.release();
    await Promise.all([join, resume]);

    const state = controller.getState();
    expect(state.sessions).toHaveLength(1);
    const active = state.active;
    expect(active).not.toBeNull();
    expect(active!.messages.map((m) => m.text)).toContain("persisted hello");
    expect(active!.lastMessagePreview).toContain("persisted hello");
    expect(active!.lastMessageAt).not.toBeNull();
    expect(active!.authFailed).toBe(true);
  });

  it("R7F3: a join deduped onto a resume that ABORTS (leave mid-flight) resolves without installing", async () => {
    const gated = gatedRepository("getConversation");
    const { controller, stats } = await makeHarness(gated.repo);
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    controller.leaveConversation(id);
    const baselinePeers = stats.peerConnectionsCreated;
    const baselineSockets = stats.socketsDialed;

    const resume = controller.resumeConversation(id);
    await gated.entered;
    const join = controller.joinConversation(`#${toHex(id)}`);
    // A leave landing while both are parked is the user's latest intent: the
    // epoch bump aborts the resume AND the join's own (stale) start attempt.
    controller.leaveConversation(id);
    gated.release();
    await Promise.all([resume, join]);

    expect(controller.getState().sessions).toHaveLength(0);
    expect(controller.getActiveConversationId()).toBeNull();
    // The resume aborted before wireBridge and the join never started its own
    // attempt — no peer connection, no socket.
    expect(stats.peerConnectionsCreated).toBe(baselinePeers);
    expect(stats.socketsDialed).toBe(baselineSockets);
  });

  it("R7F3: a join issued AFTER a leave falls through the pre-leave in-flight attempt to a fresh start", async () => {
    const gated = gatedRepository("createConversation");
    const { controller, stats } = await makeHarness(gated.repo);
    const id = hexToConversationId(HEX);

    // Park join #1 inside orchestrator.join's createConversation write — it
    // is still a pre-leave attempt (its lifecycle epoch was snapshotted at
    // its own entry).
    const first = controller.joinConversation(`${BASE_URL}#${HEX}`);
    await gated.entered;
    // A leave lands while #1 is parked: the epoch bump makes #1's completing
    // start abort quietly, installing nothing.
    controller.leaveConversation(id);
    // Join #2 arrives AFTER the leave — a same-map dedupe onto #1 used to
    // resolve quietly with no session (a silent no-op). It must await #1,
    // observe nothing was installed, and start a fresh attempt under its
    // own post-leave epoch.
    const second = controller.joinConversation(`#${HEX}`);
    gated.release();
    await Promise.all([first, second]);

    expect(controller.getState().sessions).toHaveLength(1);
    // Exactly one bridge/socket belongs to join #2 — #1 aborted before
    // wireBridge and never dialed.
    expect(stats.peerConnectionsCreated).toBe(1);
    expect(stats.socketsDialed).toBe(1);
    const active = controller.getActiveConversationId() as ConversationId;
    expect(bytesEqual(active, id)).toBe(true);
  });

  it("R7F3: a resume issued AFTER a leave falls through the pre-leave in-flight attempt to a fresh start", async () => {
    const gated = gatedRepository("getConversation");
    const { controller, stats } = await makeHarness(gated.repo);
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    controller.leaveConversation(id);
    const baselinePeers = stats.peerConnectionsCreated;
    const baselineSockets = stats.socketsDialed;

    // Park resume #1 at its first repository read — still a pre-leave
    // attempt (its lifecycle epoch was captured before the leave below).
    const first = controller.resumeConversation(id);
    await gated.entered;
    // A leave lands while #1 is parked: its completing start aborts quietly.
    controller.leaveConversation(id);
    // Resume #2 arrives AFTER the leave — a same-map dedupe onto #1 used to
    // resolve quietly with no session. It must fall through to a fresh
    // resume under its own post-leave epoch.
    const second = controller.resumeConversation(id);
    gated.release();
    await Promise.all([first, second]);

    expect(controller.getState().sessions).toHaveLength(1);
    expect(stats.peerConnectionsCreated).toBe(baselinePeers + 1);
    expect(stats.socketsDialed).toBe(baselineSockets + 1);
    const active = controller.getActiveConversationId() as ConversationId;
    expect(bytesEqual(active, id)).toBe(true);
  });

  it("R7F4: sendFile on a clearConversation-detached session re-arms transfer mirroring", async () => {
    const controllerA = (await makeHarness()).controller;
    const controllerB = (await makeHarness()).controller;
    const { idA, idB } = await linkControllers(controllerA, controllerB);

    // clearConversation sets session.detached — without the R7F4 re-arm every
    // transfer event is dropped at the chat-session gate and the send is
    // invisible in the snapshot.
    await controllerA.clearConversation(idA);
    expect(controllerA.getState().active?.transfers).toEqual([]);

    await controllerA.sendFile(idA, makeFile("re-arm me", "rearm.txt"));
    const outbound = controllerA.getState().active?.transfers ?? [];
    expect(outbound.some((t) => t.name === "rearm.txt" && t.direction === "sent")).toBe(true);

    // Inbound mirroring re-armed too: a file the peer sends back reaches
    // onFileReceived (the detached gate in chat-session.ts) instead of being
    // dropped. Assert via getReceivedFile — the snapshot's dedup-by-id start
    // event folds the received transfer into A's own same-numbered sent row
    // (both sides allocate transfer ids independently), so the transfer LIST
    // cannot observe it.
    const bTransferId = await controllerB.sendFile(idB, makeFile("reply", "reply.txt"));
    await tick(150);
    const received = controllerA.getReceivedFile(idA, bTransferId);
    expect(received).not.toBeNull();
    expect(received!.manifest.name).toBe("reply.txt");
  });

  it("R7F5: a throwing resume seed unregisters the half-started session (no phantom, no dial)", async () => {
    const failable = failableGetMessagesRepository();
    const { controller, stats } = await makeHarness(failable.repo);
    await controller.startConversation();
    const id = controller.getActiveConversationId() as ConversationId;
    controller.leaveConversation(id);
    const baselineSockets = stats.socketsDialed;
    // state.error is only surfaced to subscribers (getState rebuilds with
    // error:null), so capture emissions directly.
    const emittedErrors: (string | null)[] = [];
    controller.subscribe((s) => {
      emittedErrors.push(s.error);
    });

    // The seed hook (orchestrator.getHistory -> repository.getMessages)
    // throws after the session registered but before bridge.start().
    failable.failNextGetMessages(new Error("seed boom"));
    await expect(controller.resumeConversation(id)).rejects.toThrow("seed boom");

    // No phantom: the registered-but-never-started session was torn down and
    // evicted — retry()/resumeConversation can recover what a phantom would
    // have short-circuited as "already live".
    expect(controller.getState().sessions).toHaveLength(0);
    expect(controller.getActiveConversationId()).toBeNull();
    expect(stats.socketsDialed).toBe(baselineSockets);
    expect(emittedErrors).toContain("seed boom");

    // Recovery: the next resume builds a fresh, healthy session.
    await controller.resumeConversation(id);
    expect(controller.getState().sessions).toHaveLength(1);
    expect(controller.getState().active).not.toBeNull();
  });

  it("R7F10: a throwing subscriber does not starve other listeners or propagate into emit's caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { controller } = await makeHarness();
      const seen: string[] = [];
      controller.subscribe(() => {
        throw new Error("listener boom");
      });
      controller.subscribe((state) => {
        seen.push(state.connectionState);
      });

      // Without the per-listener guard, the first subscriber's throw both
      // starved `seen` and propagated into startConversation's emit.
      const { invitation } = await controller.startConversation();
      expect(invitation).toContain("#");
      expect(seen.length).toBeGreaterThan(0);
      expect(seen).toContain("waiting");
      expect(warn).toHaveBeenCalled();
      expect(controller.getState().conversationId).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("R13F5: markSafetyNumberVerified does not report verified when no safety number exists", async () => {
    const { controller } = await makeHarness();
    await controller.startConversation();
    // The handshake never ran: the orchestrator's safetyNumberValue is null
    // and its markSafetyNumberVerified is a no-op — the controller must not
    // latch the session flag anyway.
    expect(controller.getState().safetyNumber).toBeNull();
    controller.markSafetyNumberVerified();
    expect(controller.getState().safetyNumberVerified).toBe(false);
  });

  it("R13F5: markSafetyNumberVerified latches once a real safety number exists", async () => {
    const controllerA = (await makeHarness()).controller;
    const controllerB = (await makeHarness()).controller;
    const { idA } = await linkControllers(controllerA, controllerB);
    void idA;

    expect(controllerA.getState().safetyNumber).not.toBeNull();
    controllerA.markSafetyNumberVerified();
    expect(controllerA.getState().safetyNumberVerified).toBe(true);
  });
});
