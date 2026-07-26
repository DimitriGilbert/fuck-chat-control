import { encryptFrame } from "../crypto/aead";
import { MAX_BUFFERED_DATA_BYTES, MAX_SEQUENCE, PROTOCOL_VERSION } from "../protocol/limits";
import { ControlSubtype, CONTROL_SUBTYPE_VALUES, FrameType } from "../protocol/types";
import type { FrameAad, FrameHeader } from "../protocol/types";

import { FramingError, FramingErrorCode } from "./errors";
import { chunkBoundaries, computeChunkCount, encodeManifest, sha256 } from "./manifest";
import type { FileManifest, FrameSenderConfig } from "./types";
import { encodeWireFrame } from "./wire";

const UINT32_MAX = 0xffffffff;
const FIRST_TRANSFER_ID = 1;

interface DrainWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly transferId: number;
}

export class FrameSender {
  private readonly config: FrameSenderConfig;
  private sequence = 0;
  private nextTransferId = FIRST_TRANSFER_ID;
  private readonly activeTransfers = new Set<number>();
  private readonly cancelledTransfers = new Set<number>();
  private readonly drainWaiters: DrainWaiter[] = [];
  private tearingDown = false;

  constructor(config: FrameSenderConfig) {
    this.config = config;
    this.config.transport.setDrainListener(this.handleDrain);
  }

  get activeTransferCount(): number {
    return this.activeTransfers.size;
  }

  isFileBackpressured(): boolean {
    return this.config.transport.bufferedAmount >= MAX_BUFFERED_DATA_BYTES;
  }

  async sendText(plaintext: Uint8Array): Promise<void> {
    this.assertNotTearingDown();
    await this.sendEncryptedFrame(FrameType.Text, plaintext, 0, 0);
  }

  async sendControl(subtype: ControlSubtype, payload: Uint8Array): Promise<void> {
    this.assertNotTearingDown();
    if (!CONTROL_SUBTYPE_VALUES.includes(subtype)) {
      throw new FramingError(
        FramingErrorCode.UnknownControlSubtype,
        `unknown control subtype 0x${subtype.toString(16)}`,
      );
    }
    const body = new Uint8Array(1 + payload.length);
    body[0] = subtype;
    body.set(payload, 1);
    await this.sendEncryptedFrame(FrameType.Control, body, 0, 0);
  }

  async sendFile(data: Uint8Array, name: string, mimeType: string): Promise<number> {
    this.assertNotTearingDown();
    const transferId = this.allocateTransferId();
    const contentHash = await sha256(data);
    const chunkCount = computeChunkCount(data.length);
    const manifest: FileManifest = {
      transferId,
      name,
      mimeType,
      size: data.length,
      chunkCount,
      contentHash,
    };
    this.activeTransfers.add(transferId);
    try {
      this.assertNotTearingDown(transferId);
      await this.sendEncryptedFrame(
        FrameType.FileManifest,
        encodeManifest(manifest),
        transferId,
        0,
      );
      this.config.onTransferStart?.(transferId, name, mimeType, data.length);
      for (let i = 0; i < chunkCount; i++) {
        this.assertNotTearingDown(transferId);
        await this.waitForDrain(transferId);
        this.assertNotTearingDown(transferId);
        const { start, end } = chunkBoundaries(data.length, i);
        const chunk = data.subarray(start, end);
        await this.sendEncryptedFrame(FrameType.FileChunk, chunk, transferId, i);
        this.config.onProgress?.(transferId, end, data.length);
      }
    } finally {
      this.activeTransfers.delete(transferId);
      this.cancelledTransfers.delete(transferId);
    }
    return transferId;
  }

  cancelTransfer(transferId: number): void {
    if (!this.activeTransfers.has(transferId)) return;
    this.cancelledTransfers.add(transferId);
    this.activeTransfers.delete(transferId);
    this.rejectWaiters(
      transferId,
      new FramingError(FramingErrorCode.TransferCancelled, `transfer ${transferId} cancelled`),
    );
  }

  teardown(): void {
    this.tearingDown = true;
    this.config.transport.setDrainListener(null);
    const error = new FramingError(FramingErrorCode.TearingDown, "sender is tearing down");
    const waiters = this.drainWaiters.splice(0, this.drainWaiters.length);
    for (const w of waiters) w.reject(error);
    this.activeTransfers.clear();
  }

  private readonly handleDrain = (): void => {
    const waiters = this.drainWaiters.splice(0, this.drainWaiters.length);
    for (const w of waiters) {
      if (this.tearingDown) {
        w.reject(new FramingError(FramingErrorCode.TearingDown, "sender is tearing down"));
      } else if (this.cancelledTransfers.has(w.transferId)) {
        w.reject(
          new FramingError(
            FramingErrorCode.TransferCancelled,
            `transfer ${w.transferId} cancelled`,
          ),
        );
      } else {
        w.resolve();
      }
    }
  };

  private allocateTransferId(): number {
    if (this.nextTransferId > UINT32_MAX) {
      throw new FramingError(FramingErrorCode.SequenceExhausted, "transfer id space exhausted");
    }
    const id = this.nextTransferId;
    this.nextTransferId += 1;
    return id;
  }

  private nextSequence(): number {
    if (this.sequence > MAX_SEQUENCE) {
      throw new FramingError(
        FramingErrorCode.SequenceExhausted,
        `sequence exceeds MAX_SEQUENCE (${MAX_SEQUENCE})`,
      );
    }
    const seq = this.sequence;
    this.sequence += 1;
    return seq;
  }

  private async waitForDrain(transferId: number): Promise<void> {
    while (this.isFileBackpressured()) {
      this.assertNotTearingDown(transferId);
      await new Promise<void>((resolve, reject) => {
        this.drainWaiters.push({ resolve, reject, transferId });
      });
      this.assertNotTearingDown(transferId);
    }
  }

  private rejectWaiters(transferId: number, error: Error): void {
    for (let i = this.drainWaiters.length - 1; i >= 0; i--) {
      if (this.drainWaiters[i].transferId === transferId) {
        const [waiter] = this.drainWaiters.splice(i, 1);
        waiter.reject(error);
      }
    }
  }

  private assertNotTearingDown(transferId?: number): void {
    if (this.tearingDown) {
      throw new FramingError(FramingErrorCode.TearingDown, "sender is tearing down");
    }
    if (transferId !== undefined && this.cancelledTransfers.has(transferId)) {
      throw new FramingError(
        FramingErrorCode.TransferCancelled,
        `transfer ${transferId} cancelled`,
      );
    }
  }

  private async sendEncryptedFrame(
    frameType: FrameType,
    plaintext: Uint8Array,
    transferId: number,
    chunkId: number,
  ): Promise<void> {
    this.assertNotTearingDown(transferId);
    const sequence = this.nextSequence();
    const aad: FrameAad = {
      protocolVersion: PROTOCOL_VERSION,
      senderSessionId: this.config.localSessionId,
      senderSequence: sequence,
      frameType,
      transferId,
      chunkId,
    };
    const enc = await encryptFrame(this.config.sessionKeys.sendKey, aad, plaintext);
    const header: FrameHeader = { ...aad, ciphertextLength: enc.ciphertext.length };
    const wire = encodeWireFrame(header, enc.nonce, enc.ciphertext);
    this.config.transport.send(wire);
  }
}
