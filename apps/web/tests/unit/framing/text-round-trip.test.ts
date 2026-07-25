import { describe, expect, it } from "vitest";

import { generateAtRestKey } from "@/features/chat/crypto";
import { GCM_NONCE_BYTES, FRAME_HEADER_BYTES } from "@/features/chat/protocol/limits";
import { ControlSubtype, FrameType } from "@/features/chat/protocol/types";

import {
  FrameReceiver,
  FramingError,
  FramingErrorCode,
  decodeWireFrame,
} from "@/features/chat/framing";
import type { FrameReceiverHandlers } from "@/features/chat/framing";
import { bytesEqual, makePair, sessionId, utf8 } from "./_helpers";

function recordingHandlers(): { texts: Uint8Array[]; handlers: FrameReceiverHandlers } {
  const texts: Uint8Array[] = [];
  return {
    texts,
    handlers: {
      onText: (p) => {
        texts.push(p);
      },
      onControl: () => {
        throw new Error("unexpected control");
      },
      onFileComplete: () => {
        throw new Error("unexpected file");
      },
    },
  };
}

describe("slice 1: encrypted text frame round-trip", () => {
  it("round-trips a text frame through sender -> transport -> receiver", async () => {
    const rec = recordingHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    await sender.sendText(utf8("hello world"));
    await transport.ingestSettled;
    expect(rec.texts).toHaveLength(1);
    expect(bytesEqual(rec.texts[0], utf8("hello world"))).toBe(true);
  });

  it("round-trips a control frame", async () => {
    const controls: { subtype: ControlSubtype; payload: Uint8Array }[] = [];
    const { sender, transport } = await makePair({
      onText: () => {
        throw new Error("unexpected text");
      },
      onControl: (subtype, payload) => {
        controls.push({ subtype, payload });
      },
      onFileComplete: () => {
        throw new Error("unexpected file");
      },
    });
    await sender.sendControl(ControlSubtype.Leave, utf8("bye"));
    await transport.ingestSettled;
    expect(controls).toHaveLength(1);
    expect(controls[0].subtype).toBe(ControlSubtype.Leave);
    expect(bytesEqual(controls[0].payload, utf8("bye"))).toBe(true);
  });

  it("emits wire bytes as header(50) + nonce(12) + ciphertext", async () => {
    const rec = recordingHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    await sender.sendText(utf8("payload"));
    expect(transport.sent).toHaveLength(1);
    const wire = transport.sent[0];
    const parsed = decodeWireFrame(wire);
    expect(wire.length).toBe(FRAME_HEADER_BYTES + GCM_NONCE_BYTES + parsed.ciphertextLength);
    expect(parsed.aad.frameType).toBe(FrameType.Text);
    expect(parsed.aad.transferId).toBe(0);
    expect(parsed.aad.chunkId).toBe(0);
  });

  it("assigns monotonically increasing sequence numbers", async () => {
    const rec = recordingHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    await sender.sendText(utf8("a"));
    await sender.sendText(utf8("b"));
    await transport.ingestSettled;
    expect(decodeWireFrame(transport.sent[0]).aad.senderSequence).toBe(0);
    expect(decodeWireFrame(transport.sent[1]).aad.senderSequence).toBe(1);
  });
});

describe("slice 2: replay-window and wrong-session rejection", () => {
  it("rejects a tampered ciphertext (AEAD tag)", async () => {
    const rec = recordingHandlers();
    const { sender, transport, recvKeys, peerSessionId } = await makePair(rec.handlers);
    await sender.sendText(utf8("secret"));
    const fresh = new FrameReceiver({
      sessionKeys: recvKeys,
      peerSessionId,
      ...rec.handlers,
    });
    const wire = new Uint8Array(transport.sent[0]);
    wire[wire.length - 1] ^= 0xff;
    await expect(fresh.ingest(wire)).rejects.toBeInstanceOf(FramingError);
  });

  it("rejects a replayed frame (duplicate sequence)", async () => {
    const rec = recordingHandlers();
    const { sender, receiver, transport } = await makePair(rec.handlers);
    await sender.sendText(utf8("once"));
    await transport.ingestSettled;
    expect(rec.texts).toHaveLength(1);
    await expect(receiver.ingest(transport.sent[0])).rejects.toMatchObject({
      code: FramingErrorCode.Malformed,
    });
    expect(rec.texts).toHaveLength(1);
  });

  it("rejects a frame whose AAD type was altered", async () => {
    const rec = recordingHandlers();
    const { sender, transport, recvKeys, peerSessionId } = await makePair(rec.handlers);
    await sender.sendText(utf8("x"));
    const fresh = new FrameReceiver({
      sessionKeys: recvKeys,
      peerSessionId,
      ...rec.handlers,
    });
    const wire = new Uint8Array(transport.sent[0]);
    const typeOffset = 1 + 32 + 4;
    wire[typeOffset] = FrameType.Control;
    await expect(fresh.ingest(wire)).rejects.toBeInstanceOf(FramingError);
  });

  it("rejects a frame from the wrong sender session id", async () => {
    const rec = recordingHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    await sender.sendText(utf8("y"));
    const standalone = new FrameReceiver({
      sessionKeys: { sendKey: generateAtRestKey(), recvKey: generateAtRestKey() },
      peerSessionId: sessionId(999),
      ...rec.handlers,
    });
    await expect(standalone.ingest(transport.sent[0])).rejects.toMatchObject({
      code: FramingErrorCode.WrongSession,
    });
  });

  it("rejects a malformed (truncated) wire frame", async () => {
    const rec = recordingHandlers();
    const { receiver } = await makePair(rec.handlers);
    await expect(receiver.ingest(new Uint8Array(10))).rejects.toMatchObject({
      code: FramingErrorCode.Malformed,
    });
  });

  it("rejects a frame whose ciphertext length field is dishonest", async () => {
    const rec = recordingHandlers();
    const { sender, transport, recvKeys, peerSessionId } = await makePair(rec.handlers);
    await sender.sendText(utf8("z"));
    const fresh = new FrameReceiver({
      sessionKeys: recvKeys,
      peerSessionId,
      ...rec.handlers,
    });
    const wire = new Uint8Array(transport.sent[0]);
    const lenOffset = FRAME_HEADER_BYTES - 4;
    wire[lenOffset] = 0xff;
    await expect(fresh.ingest(wire)).rejects.toMatchObject({
      code: FramingErrorCode.Malformed,
    });
  });

  it("rejects a frame encrypted under a wrong key", async () => {
    const rec = recordingHandlers();
    const { sender, transport, peerSessionId } = await makePair(rec.handlers);
    await sender.sendText(utf8("payload"));
    const wrongKeyReceiver = new FrameReceiver({
      sessionKeys: { sendKey: generateAtRestKey(), recvKey: generateAtRestKey() },
      peerSessionId,
      ...rec.handlers,
    });
    await expect(wrongKeyReceiver.ingest(transport.sent[0])).rejects.toBeInstanceOf(FramingError);
  });
});
