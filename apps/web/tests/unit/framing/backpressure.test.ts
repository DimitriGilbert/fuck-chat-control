import { describe, expect, it } from "vitest";

import { MAX_BUFFERED_DATA_BYTES } from "@/features/chat/protocol/limits";
import { ControlSubtype, FrameType } from "@/features/chat/protocol/types";

import { decodeWireFrame, MAX_CHUNK_PLAINTEXT_BYTES } from "@/features/chat/framing";
import type { FrameReceiverHandlers, ReceivedFile } from "@/features/chat/framing";
import { bytesEqual, deterministicData, makePair, utf8 } from "./_helpers";
import type { LinkedPair } from "./_helpers";

function collectHandlers(): {
  texts: Uint8Array[];
  controls: { subtype: ControlSubtype; payload: Uint8Array }[];
  files: ReceivedFile[];
  handlers: FrameReceiverHandlers;
} {
  const texts: Uint8Array[] = [];
  const controls: { subtype: ControlSubtype; payload: Uint8Array }[] = [];
  const files: ReceivedFile[] = [];
  return {
    texts,
    controls,
    files,
    handlers: {
      onText: (p) => {
        texts.push(p);
      },
      onControl: (subtype, payload) => {
        controls.push({ subtype, payload });
      },
      onFileComplete: (file) => {
        files.push(file);
      },
    },
  };
}

function isChunkFrame(wire: Uint8Array): boolean {
  return decodeWireFrame(wire).aad.frameType === FrameType.FileChunk;
}

describe("slice 6: backpressure reserves capacity for text and control", () => {
  it("passes text frames while file chunks are paused", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    transport.setBufferedAmount(MAX_BUFFERED_DATA_BYTES);
    await sender.sendText(utf8("priority"));
    const data = deterministicData(MAX_CHUNK_PLAINTEXT_BYTES * 2, 4);
    const filePromise = sender.sendFile(data, "payload.bin", "application/octet-stream");
    await transport.ingestSettled;
    expect(rec.texts).toHaveLength(1);
    expect(bytesEqual(rec.texts[0], utf8("priority"))).toBe(true);
    expect(transport.sent.filter(isChunkFrame)).toHaveLength(0);
    expect(rec.files).toHaveLength(0);
    transport.setBufferedAmount(0);
    transport.triggerDrain();
    await filePromise;
    await transport.ingestSettled;
    expect(rec.files).toHaveLength(1);
    expect(bytesEqual(rec.files[0].data, data)).toBe(true);
  });

  it("passes control frames while file chunks are paused", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    transport.setBufferedAmount(MAX_BUFFERED_DATA_BYTES);
    await sender.sendControl(ControlSubtype.Leave, utf8("bye"));
    const data = deterministicData(MAX_CHUNK_PLAINTEXT_BYTES * 2, 4);
    const filePromise = sender.sendFile(data, "payload.bin", "application/octet-stream");
    await transport.ingestSettled;
    expect(rec.controls).toHaveLength(1);
    expect(rec.controls[0].subtype).toBe(ControlSubtype.Leave);
    expect(transport.sent.filter(isChunkFrame)).toHaveLength(0);
    transport.setBufferedAmount(0);
    transport.triggerDrain();
    await filePromise;
    await transport.ingestSettled;
    expect(rec.files).toHaveLength(1);
  });

  it("does not pause file chunks under the cap", async () => {
    const rec = collectHandlers();
    const { sender, transport } = await makePair(rec.handlers);
    transport.setBufferedAmount(MAX_BUFFERED_DATA_BYTES - 1);
    const data = deterministicData(MAX_CHUNK_PLAINTEXT_BYTES * 2, 4);
    await sender.sendFile(data, "payload.bin", "application/octet-stream");
    await transport.ingestSettled;
    expect(transport.sent.filter(isChunkFrame)).toHaveLength(2);
    expect(rec.files).toHaveLength(1);
  });

  it("reflects backpressure state via isFileBackpressured", async () => {
    const rec = collectHandlers();
    const pair: LinkedPair = await makePair(rec.handlers);
    pair.transport.setBufferedAmount(MAX_BUFFERED_DATA_BYTES);
    expect(pair.sender.isFileBackpressured()).toBe(true);
    pair.transport.setBufferedAmount(0);
    expect(pair.sender.isFileBackpressured()).toBe(false);
  });
});
