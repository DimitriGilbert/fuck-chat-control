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
// `127.0.0.1` always fails with ECONNREFUSED. Use the hostname.
const HOST = "localhost";
const PORT = 3002;
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

interface CloseEventLike {
  readonly code: number;
  readonly reason: string;
}

function waitForClose(socket: WsClient, timeoutMs = 5000): Promise<CloseEventLike> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener("close", onClose);
      reject(new Error(`Socket did not close within ${timeoutMs} ms`));
    }, timeoutMs);
    const onClose = (code: number, reason: Buffer): void => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    };
    socket.once("close", onClose);
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

describe("broker rejects double-join from an already-seated socket (R5/F1)", () => {
  it("closes the offender with the AlreadySeated (4003) close code", async () => {
    const a = await connectClient(WS_URL);
    try {
      a.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      a.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));

      const close = await waitForClose(a, 5000);
      expect(close.code).toBe(4003);
      expect(close.reason).toContain("already in a room");
    } finally {
      closeQuietly(a);
    }
  });

  it("the abandoned partner can accept a fresh peer after the offender's socket is reaped", async () => {
    // a and b share a room. a sends a second join on the SAME socket and is
    // hard-closed with 4003. With the silent-abandon bug, a's first seat would
    // be released WITHOUT notifying b, AND a would silently re-seat as the
    // second peer — leaving b's peerPresent stuck true with no real partner.
    // With the fix, a's second join does NOT silently leave; a's first seat
    // is released only when the WS close frame triggers the runtime close hook
    // (the legitimate path), which DOES notify b. The contract this test pins
    // is the user-visible one: after a's socket is reaped, a NEW peer can join
    // b — proving the slot was released cleanly rather than silently abandoned.
    const a = await connectClient(WS_URL);
    const b = await connectClient(WS_URL);
    try {
      a.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      b.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      await awaitRoomSettled(a, b, ROOM_ID);

      // Drain any straggler ICE probes from awaitRoomSettled.
      await sleep(200);
      b.removeAllListeners("message");

      // a offends; the broker hard-closes a's socket.
      a.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));
      const offenderClose = await waitForClose(a, 5000);
      expect(offenderClose.code).toBe(4003);

      // The runtime close hook fires asynchronously on the WS close frame,
      // routes through BrokerConnection.onClose, and sends b a `leave` for a's
      // original seat. This is the CORRECT notifyPeerLeft path — distinct from
      // the silent-leave the bug would have produced (which would NOT have
      // notified b).
      const leaveRaw = await nextMessage(b, 5000);
      const leave = JSON.parse(leaveRaw) as { t: string };
      expect(leave.t).toBe("leave");

      // Now a fresh peer c can join b — proving the slot was released cleanly.
      // (Under the silent-abandon bug, a would still occupy the slot from b's
      // perspective and the partner would be stuck.)
      const c = await connectClient(WS_URL);
      c.send(JSON.stringify({ t: "join", roomId: ROOM_ID }));

      // The broker notifies the EXISTING peer b when c becomes the second
      // peer — so b is where we look for c's arrival.
      const joinRaw = await nextMessage(b, 5000);
      const join = JSON.parse(joinRaw) as { t: string; roomId: string };
      expect(join.t).toBe("join");
      expect(join.roomId).toBe(ROOM_ID);

      c.close();
    } finally {
      closeQuietly(a);
      closeQuietly(b);
    }
  });

  it("a fresh socket joining after a previous socket's clean leave still works", async () => {
    // Regression guard: the reject-double-join path must not have broken the
    // legitimate "leave then fresh-join" flow. The legitimate client always
    // opens a fresh socket per join; this asserts that path is unchanged.
    const a = await connectClient(WS_URL);
    const b = await connectClient(WS_URL);
    try {
      a.send(JSON.stringify({ t: "join", roomId: "ffeeddccbbaa99887766554433221100" }));
      b.send(JSON.stringify({ t: "join", roomId: "ffeeddccbbaa99887766554433221100" }));
      await awaitRoomSettled(a, b, "ffeeddccbbaa99887766554433221100");

      a.send(JSON.stringify({ t: "leave", roomId: "ffeeddccbbaa99887766554433221100" }));
      await sleep(200);

      const a2 = await connectClient(WS_URL);
      a2.send(JSON.stringify({ t: "join", roomId: "ffeeddccbbaa99887766554433221100" }));
      // b should now see a fresh join notification for a2.
      const bJoin = JSON.parse(await nextMessage(b, 5000)) as { t: string };
      expect(bJoin.t).toBe("join");
      a2.close();
    } finally {
      closeQuietly(a);
      closeQuietly(b);
    }
  });
});
