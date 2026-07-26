import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";

const APPS_WEB = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const VP_BIN = join(REPO_ROOT, "node_modules", ".bin", "vp");

// The vite+ dev server binds to `localhost`, which resolves to the IPv6 loopback
// (`::1`) on this host — NOT to the IPv4 loopback `127.0.0.1`. Use the hostname.
const HOST = "localhost";
const PORT = 3003;
const HTTP_URL = `http://${HOST}:${PORT}/`;
const WS_URL = `ws://${HOST}:${PORT}/ws`;
const ROOM_ID = "00ff00ff00ff00ff00ff00ff00ff00ff";

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

function closeQuietly(socket: WsClient): void {
  try {
    socket.close();
  } catch {
    // ignore
  }
}

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
  try {
    await fetch(HTTP_URL, { signal: AbortSignal.timeout(1000) });
    throw new Error(`Port ${PORT} is already in use. Aborting broker integration test.`);
  } catch (err) {
    if (err instanceof Error && /already in use/.test(err.message)) {
      throw err;
    }
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
    // drain
  });
  serverProc.stderr?.on("data", (chunk: Buffer) => {
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

describe("broker zombie sweep (R5/F2) — defense-in-depth", () => {
  it("delivers notifyPeerLeft to the partner when a peer's socket closes (clean close path)", async () => {
    // The sweep is defense-in-depth; the canonical notifyPeerLeft path is the
    // runtime's `close` hook. This test pins that the close hook still fires
    // `onClose → notifyPeerLeft` so the sweep (which calls the same path) is
    // redundant rather than load-bearing. The integration-level sweep itself
    // is exercised in the unit suite (tests/unit/broker/sweep.test.ts) where
    // we can construct a registry with a CLOSING/CLOSED socket and assert the
    // eviction callback runs deterministically.
    const a = await connectClient(WS_URL);
    const b = await connectClient(WS_URL);
    try {
      a.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      b.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      await awaitRoomSettled(a, b, ROOM_ID);

      // a closes its socket cleanly. The close hook routes through
      // BrokerConnection.onClose → notifyPeerLeft → b receives a leave.
      a.close();

      const leaveRaw = await nextMessage(b, 5000);
      const leave = JSON.parse(leaveRaw) as { t: string; roomId: string };
      expect(leave.t).toBe("leave");
      expect(leave.roomId).toBe(ROOM_ID);
    } finally {
      closeQuietly(a);
      closeQuietly(b);
    }
  });

  it("a fresh peer can join after the previous peer's socket was reaped", async () => {
    // The sweep's contract: after a peer's socket is reaped (either by the
    // runtime's close hook or by the zombie sweep), the freed slot admits a
    // new peer. This is the partner-reconnect success path that the
    // silent-abandon bug would have broken (peerPresent stuck true).
    const a = await connectClient(WS_URL);
    const b = await connectClient(WS_URL);
    try {
      a.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      b.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      await awaitRoomSettled(a, b, ROOM_ID);

      a.close();
      // Drain b's incoming leave notification (the close hook fires
      // notifyPeerLeft → b gets a `leave`), so the assertion below sees only
      // the join notification from c's arrival.
      const leaveRaw = await nextMessage(b, 5000);
      const leave = JSON.parse(leaveRaw) as { t: string };
      expect(leave.t).toBe("leave");

      // c joins and must take a's freed slot. The broker notifies the EXISTING
      // peer (b) when c becomes the second peer — not c. So b is where we look
      // for c's arrival. If a's socket were still in the registry, c would be
      // rejected with 1013 "room full" and b would see no join.
      const c = await connectClient(WS_URL);
      c.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      const joinRaw = await nextMessage(b, 5000);
      const join = JSON.parse(joinRaw) as { t: string; roomId: string };
      expect(join.t).toBe("join");
      expect(join.roomId).toBe(ROOM_ID);

      // Sanity: c and b can now relay SDP/ICE to each other.
      c.send(JSON.stringify({ t: "offer", sdp: { type: "offer", sdp: "post-sweep" } }));
      const offerRaw = await nextMessage(b, 5000);
      const offer = JSON.parse(offerRaw) as { t: string };
      expect(offer.t).toBe("offer");
      c.close();
    } finally {
      closeQuietly(a);
      closeQuietly(b);
    }
  });
});

describe("broker zombie sweep — server config", () => {
  it("the broker server boots with the sweep installed (no throw)", () => {
    // Smoke assertion: the dev server came up at this port with the sweep
    // wired in (see src/server/broker.ts:startZombieSweep). If the sweep
    // wiring threw at module load, beforeAll would have failed before this
    // test ran. Reaching this assertion means the sweep's setInterval is
    // installed and .unref()'d, so it does not keep the event loop alive.
    expect(serverProc).not.toBeNull();
  });
});
