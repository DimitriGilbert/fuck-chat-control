import { describe, expect, it } from "vitest";

import type { FileManifest, ReceivedFile } from "@/features/chat/framing";
import type { ConversationOrchestrator } from "@/features/chat/orchestrator/orchestrator";
import { ConnectionState } from "@/features/chat/signaling/state-machine";
import { teardownSession } from "@/features/chat/runtime/chat-session";
import type { ChatSession } from "@/features/chat/runtime/types";
import type { WebRtcBridge } from "@/features/chat/runtime/webrtc-bridge";
import { AuthMode } from "@/features/chat/protocol/types";
import type { ConversationId } from "@/features/chat/protocol/types";

/**
 * Minimal stubs: teardownSession only calls `orchestrator.leave()` and
 * `bridge.close()`. The real coverage of those is in their own suites; here
 * we assert the received-files zeroing + clearing contract (R9/F7).
 */
function makeSession(files: ReceivedFile[]): ChatSession {
  const orchestrator = { leave(): void {} } as unknown as ConversationOrchestrator;
  const bridge = { close(): void {} } as unknown as WebRtcBridge;
  const receivedFiles = new Map<number, ReceivedFile>();
  for (const file of files) {
    receivedFiles.set(file.manifest.transferId, file);
  }
  return {
    id: new Uint8Array(16) as ConversationId,
    orchestrator,
    bridge,
    connectionState: ConnectionState.Connected,
    messages: [],
    safetyNumber: null,
    safetyNumberVerified: false,
    unread: 0,
    draft: "",
    invitation: null,
    record: null,
    lastMessagePreview: null,
    lastMessageAt: null,
    lastReceivedAt: null,
    transfers: [],
    receivedFiles,
    detached: false,
    authFailed: false,
    authMode: AuthMode.SafetyNumberOnly,
  };
}

function makeReceivedFile(transferId: number, bytes: number[]): ReceivedFile {
  const manifest: FileManifest = {
    transferId,
    name: `file-${transferId}.bin`,
    mimeType: "application/octet-stream",
    size: bytes.length,
    chunkCount: 1,
    contentHash: new Uint8Array(0),
  };
  return { manifest, data: new Uint8Array(bytes) };
}

describe("teardownSession clears receivedFiles + zeroes byte buffers (R9/F7)", () => {
  it("zeroes every received file's data buffer and clears the map", () => {
    const fileA = makeReceivedFile(1, [0xde, 0xad, 0xbe, 0xef]);
    const fileB = makeReceivedFile(2, [0x01, 0x02, 0x03, 0x04, 0x05]);
    // Keep references so we can read the buffers after teardown.
    const bufA = fileA.data;
    const bufB = fileB.data;
    const session = makeSession([fileA, fileB]);

    teardownSession(session);

    // The map was cleared.
    expect(session.receivedFiles.size).toBe(0);
    // The underlying buffers were zeroed in place.
    for (const b of bufA) expect(b).toBe(0);
    for (const b of bufB) expect(b).toBe(0);
    // Connection state dropped.
    expect(session.connectionState).toBe(ConnectionState.Disconnected);
  });

  it("is a no-op on receivedFiles when the session has none", () => {
    const session = makeSession([]);
    teardownSession(session);
    expect(session.receivedFiles.size).toBe(0);
    expect(session.connectionState).toBe(ConnectionState.Disconnected);
  });

  it("still runs orchestrator.leave + bridge.close (best-effort) when zeroing succeeds", () => {
    let leaveCalled = false;
    let bridgeClosed = false;
    const orchestrator = { leave(): void {
      leaveCalled = true;
    } } as unknown as ConversationOrchestrator;
    const bridge = { close(): void {
      bridgeClosed = true;
    } } as unknown as WebRtcBridge;
    const session: ChatSession = {
      id: new Uint8Array(16) as ConversationId,
      orchestrator,
      bridge,
      connectionState: ConnectionState.Connected,
      messages: [],
      safetyNumber: null,
      safetyNumberVerified: false,
      unread: 0,
      draft: "",
      invitation: null,
      record: null,
      lastMessagePreview: null,
      lastMessageAt: null,
      lastReceivedAt: null,
      transfers: [],
      receivedFiles: new Map(),
      detached: false,
      authFailed: false,
      authMode: AuthMode.SafetyNumberOnly,
    };

    teardownSession(session);

    expect(leaveCalled).toBe(true);
    expect(bridgeClosed).toBe(true);
  });

  it("zeros buffers even when orchestrator.leave throws", () => {
    const file = makeReceivedFile(7, [0xca, 0xfe]);
    const buf = file.data;
    const orchestrator = {
      leave(): void {
        throw new Error("simulated leave failure");
      },
    } as unknown as ConversationOrchestrator;
    const bridge = { close(): void {} } as unknown as WebRtcBridge;
    const session: ChatSession = {
      id: new Uint8Array(16) as ConversationId,
      orchestrator,
      bridge,
      connectionState: ConnectionState.Connected,
      messages: [],
      safetyNumber: null,
      safetyNumberVerified: false,
      unread: 0,
      draft: "",
      invitation: null,
      record: null,
      lastMessagePreview: null,
      lastMessageAt: null,
      lastReceivedAt: null,
      transfers: [],
      receivedFiles: new Map([[7, file]]),
      detached: false,
      authFailed: false,
      authMode: AuthMode.SafetyNumberOnly,
    };

    // teardownSession swallows orchestrator/bridge errors; the buffer-zeroing
    // happened BEFORE those calls, so the contract still holds.
    expect(() => teardownSession(session)).not.toThrow();
    expect(session.receivedFiles.size).toBe(0);
    for (const b of buf) expect(b).toBe(0);
  });
});
