import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";

// These tests live in `packages/chat-runtime/tests/integration/` but still boot
// the `apps/web` dev server (the broker WebSocket route is served by the web
// app's Nitro server). Four `..` segments climb from `integration/` to the repo
// root, then into `apps/web/`.
const APPS_WEB = fileURLToPath(new URL("../../../../apps/web/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const VP_BIN = join(REPO_ROOT, "node_modules", ".bin", "vp");

// The vite+ dev server binds to `localhost`, which resolves to the IPv6 loopback
// (`::1`) on this host — NOT to the IPv4 loopback `127.0.0.1`. Probing
// `127.0.0.1` always fails with ECONNREFUSED, which is what previously caused
// this test to hang for the full boot timeout. Use the hostname so the OS
// resolves to whichever loopback the server actually bound.
const HOST = "localhost";
const PORT = 3001;
const HTTP_URL = `http://${HOST}:${PORT}/`;
const WS_URL = `ws://${HOST}:${PORT}/ws`;
const ROOM_ID = "0123456789abcdef0123456789abcdef";

const BOOT_TIMEOUT_MS = 60_000;
const READINESS_INTERVAL_MS = 500;

let serverProc: ChildProcess | null = null;
let bootError: Error | null = null;
let serverStderr = "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bootError !== null) {
      throw bootError;
    }
    try {
      const res = await fetch(HTTP_URL, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) {
        return;
      }
    } catch {
      // server not up yet
    }
    await sleep(READINESS_INTERVAL_MS);
  }
  const detail = serverStderr.trim();
  throw new Error(
    `Dev server did not become ready at ${HTTP_URL} within ${timeoutMs} ms.${
      detail.length > 0 ? `\nServer stderr:\n${detail}` : ""
    }`,
  );
}

function connectClient(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const socket = new WsClient(url);
    const onError = (err: Error): void => {
      socket.removeListener("open", onOpen);
      reject(err);
    };
    const onOpen = (): void => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function nextMessage(socket: WsClient, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener("message", onMessage);
      reject(new Error(`Timed out waiting for a message within ${timeoutMs} ms`));
    }, timeoutMs);
    const onMessage = (data: Buffer): void => {
      clearTimeout(timer);
      resolve(data.toString("utf8"));
    };
    socket.once("message", onMessage);
  });
}

function expectNoMessage(socket: WsClient, ms = 800): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener("message", onMessage);
      resolve();
    }, ms);
    const onMessage = (): void => {
      clearTimeout(timer);
      reject(new Error("Received an unexpected message"));
    };
    socket.once("message", onMessage);
  });
}

function closeQuietly(socket: WsClient): void {
  try {
    socket.close();
  } catch {
    // ignore
  }
}

/**
 * The broker is a pure relay with no join acknowledgment and no buffering: it
 * drops a relayable message when the recipient has not joined the room yet. Two
 * clients' WebSocket frames interleave non-deterministically at the server, so
 * an offer sent immediately after both joins can arrive before the recipient's
 * join is processed and be silently dropped.
 *
 * We settle deterministically by round-tripping a throwaway ICE probe in each
 * direction with a short retry: a probe is only delivered once the recipient is
 * registered, so when both probes land, both peers are provably in the room.
 */
async function awaitRoomSettled(a: WsClient, b: WsClient, roomId: string): Promise<void> {
  const deadline = Date.now() + 8000;
  let aReceived = false;
  let bReceived = false;

  const probeHandler = (socket: WsClient, onProbe: () => void): void => {
    socket.on("message", (data: Buffer) => {
      let parsed: { t?: string; candidate?: { probe?: string } };
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (parsed.t === "ice" && parsed.candidate?.probe !== undefined) {
        onProbe();
      }
    });
  };

  probeHandler(b, () => {
    bReceived = true;
  });
  probeHandler(a, () => {
    aReceived = true;
  });

  while (!(aReceived && bReceived) && Date.now() < deadline) {
    a.send(JSON.stringify({ t: "ice", candidate: { probe: "a->b" }, roomId }));
    b.send(JSON.stringify({ t: "ice", candidate: { probe: "b->a" }, roomId }));
    await sleep(120);
  }

  a.removeAllListeners("message");
  b.removeAllListeners("message");

  if (!aReceived || !bReceived) {
    throw new Error(
      `Room ${roomId} did not settle within 8000ms (aReceived=${aReceived}, bReceived=${bReceived})`,
    );
  }
}

beforeAll(async () => {
  if (!existsSync(VP_BIN)) {
    throw new Error(`vp binary not found at ${VP_BIN}`);
  }
  // Fail fast if something is already bound to the configured port.
  try {
    await fetch(HTTP_URL, { signal: AbortSignal.timeout(1000) });
    throw new Error(`Port ${PORT} is already in use. Aborting broker integration test.`);
  } catch (err) {
    if (err instanceof Error && /already in use/.test(err.message)) {
      throw err;
    }
    // any other failure means the port looks free — proceed to boot
  }

  serverProc = spawn(VP_BIN, ["dev"], {
    cwd: APPS_WEB,
    env: {
      ...process.env,
      HOST,
      PORT: String(PORT),
      SKIP_ENV_VALIDATION: "1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.on("error", (err: Error) => {
    bootError = err;
  });
  serverProc.stdout?.on("data", () => {
    // drain to avoid the child's stdout pipe backing up
  });
  serverProc.stderr?.on("data", (chunk: Buffer) => {
    // Capture stderr so a boot failure surfaces a useful message instead of a
    // bare "did not become ready" timeout after 60 seconds.
    serverStderr += chunk.toString("utf8");
  });

  await waitForReady(BOOT_TIMEOUT_MS);
}, BOOT_TIMEOUT_MS + 10_000);

afterAll(async () => {
  const proc = serverProc;
  serverProc = null;
  if (proc !== null && proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already dead
      }
    }
  }
  await sleep(500);
});

describe("broker WebSocket route (real dev server)", () => {
  it("boots the dev server and accepts a WebSocket upgrade on /ws", async () => {
    const socket = await connectClient(WS_URL);
    expect(socket.readyState).toBe(WsClient.OPEN);
    socket.close();
  });

  it("relays offer, answer, and ICE candidates between two peers", async () => {
    const a = await connectClient(WS_URL);
    const b = await connectClient(WS_URL);
    try {
      a.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      b.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      await awaitRoomSettled(a, b, ROOM_ID);

      a.send(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "o" } }));
      const bOffer = JSON.parse(await nextMessage(b)) as { t: string };
      expect(bOffer.t).toBe("offer");

      b.send(JSON.stringify({ t: "answer", sdp: { type: "answer", sdp: "ans" } }));
      const aAnswer = JSON.parse(await nextMessage(a)) as { t: string };
      expect(aAnswer.t).toBe("answer");

      a.send(JSON.stringify({ t: "ice", candidate: { candidate: "a->b" } }));
      const bIce = JSON.parse(await nextMessage(b)) as { t: string };
      expect(bIce.t).toBe("ice");

      b.send(JSON.stringify({ t: "ice", candidate: { candidate: "b->a" } }));
      const aIce = JSON.parse(await nextMessage(a)) as { t: string };
      expect(aIce.t).toBe("ice");
    } finally {
      closeQuietly(a);
      closeQuietly(b);
    }
  });

  it("never relays join/leave to the peer (broker is signaling-only)", async () => {
    const a = await connectClient(WS_URL);
    const b = await connectClient(WS_URL);
    try {
      a.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      b.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      a.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      a.send(JSON.stringify({ t: "leave", roomId: ROOM_ID }));
      await expectNoMessage(b, 800);
    } finally {
      closeQuietly(a);
      closeQuietly(b);
    }
  });

  it("frees a peer's slot on leave so a new peer can join as second", async () => {
    const a = await connectClient(WS_URL);
    const b = await connectClient(WS_URL);
    const c = await connectClient(WS_URL);
    try {
      const room = "fedcba9876543210fedcba9876543210";
      a.send(JSON.stringify({ t: "join", roomId: room }));
      b.send(JSON.stringify({ t: "join", roomId: room }));
      await awaitRoomSettled(a, b, room);

      // a leaves, freeing a slot; c joins and must take the freed slot.
      a.send(JSON.stringify({ t: "leave", roomId: room }));
      c.send(JSON.stringify({ t: "join", roomId: room }));
      await awaitRoomSettled(c, b, room);

      b.send(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "post-leave" } }));
      const cOffer = JSON.parse(await nextMessage(c, 5000)) as { t: string };
      expect(cOffer.t).toBe("offer");
    } finally {
      closeQuietly(a);
      closeQuietly(b);
      closeQuietly(c);
    }
  });

  it("rejects a third peer while two occupy the room", async () => {
    const a = await connectClient(WS_URL);
    const b = await connectClient(WS_URL);
    const c = await connectClient(WS_URL);
    try {
      const room = "11112222333344445555666677778888";
      a.send(JSON.stringify({ t: "join", roomId: room }));
      b.send(JSON.stringify({ t: "join", roomId: room }));
      c.send(JSON.stringify({ t: "join", roomId: room }));

      a.send(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "third" } }));
      await expectNoMessage(c, 800);
    } finally {
      closeQuietly(a);
      closeQuietly(b);
      closeQuietly(c);
    }
  });
});
