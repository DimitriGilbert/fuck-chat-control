import { encryptFrame } from "../crypto/aead";
import { encodeTransferCancelPayload } from "../protocol/codec";
import {
  MAX_BUFFERED_DATA_BYTES,
  MAX_INCOMPLETE_TRANSFER_BYTES,
  MAX_SEQUENCE,
  PROTOCOL_VERSION,
} from "../protocol/limits";
import { ControlSubtype, CONTROL_SUBTYPE_VALUES, FrameType } from "../protocol/types";
import type { FrameAad, FrameHeader } from "../protocol/types";

import type { SessionKeys } from "../crypto/types";
import { FramingError, FramingErrorCode } from "./errors";
import { chunkBoundaries, computeChunkCount, encodeManifest, sha256 } from "./manifest";
import type { FileManifest, FrameSenderConfig } from "./types";
import { encodeWireFrame } from "./wire";

const UINT32_MAX = 0xffffffff;
/**
 * R9/F4 (Phase 8.5): the sender's transfer-id space starts at 1_000_000 so
 * the controller's queued-placeholder ids ([1, 999_999]) can never collide
 * with a real orchestrator-allocated id (>= 1_000_000). Without this gap,
 * queuedId=N could be reused as a real transfer id after the queued entry
 * was drained, and the snapshot's two transfers (the queued placeholder +
 * the now-real one) would alias — late events for the queued id would
 * mutate the wrong transfer in the list. The 1M floor leaves room for ~1M
 * concurrent queued placeholders per session, far beyond any realistic UI
 * burst, while the upper space (1_000_000 .. UINT32_MAX) still fits ~4B
 * real transfers per session.
 */
const FIRST_TRANSFER_ID = 1_000_000;

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
    // LW-5: reject an oversized input BEFORE hashing it. The receiver's budget
    // check and the manifest encoder's size guard both reject sizes above
    // MAX_INCOMPLETE_TRANSFER_BYTES, but they run only after this method has
    // already paid for the sha256 over the full buffer. Hoisting the cap above
    // the hash avoids wasted work on an input that can never be sent, and
    // surfaces the error at the sender instead of after a round-trip.
    if (data.length > MAX_INCOMPLETE_TRANSFER_BYTES) {
      throw new FramingError(
        FramingErrorCode.SizeExceeded,
        `file size ${data.length} exceeds MAX_INCOMPLETE_TRANSFER_BYTES (${MAX_INCOMPLETE_TRANSFER_BYTES})`,
      );
    }
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
    } catch (err) {
      // R3/F2 (Phase 8.2): if the sender hit a fatal sequence/transfer-id
      // exhaustion mid-send, the chunks the receiver is still buffering will
      // never arrive. Emit a TransferCancel control frame so the receiver can
      // drop its matching inbound transfer state promptly instead of waiting
      // for a transport-level timeout. Fire-and-forget: we are about to
      // re-throw the original error and the transport may itself be tearing
      // down, so swallow any secondary failure of the control send.
      if (isSequenceExhaustedError(err)) {
        try {
          // sendControl routes through sendEncryptedFrame, which also consumes
          // a sequence number. Under genuine exhaustion there may not be a
          // sequence left to spend — in that case the control frame is a
          // best-effort signal and the receiver will still time out. We do
          // NOT re-enter the chunk loop; the cancel is emitted and the
          // original error propagates.
          await this.sendControl(
            ControlSubtype.TransferCancel,
            encodeTransferCancelPayload(transferId),
          );
        } catch {
          // best-effort: the original error is the one callers see.
        }
      }
      throw err;
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
    // LW-12 (Phase 7b): best-effort zeroize the session send key. JS-array
    // zeroing is best-effort — the GC and the runtime's own copies (e.g. V8's
    // externalized ArrayBuffer views) may retain a copy — but matching the
    // receivedFiles precedent (Phase 4) bounds the lifetime of the live key
    // bytes to the framing layer's own teardown. The SessionKeys are owned by
    // the orchestrator; the config reference is dropped by the caller after
    // teardown, so overwriting the bytes here is the only window the framing
    // layer has to clear them.
    zeroizeSessionKeys(this.config.sessionKeys);
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

/**
 * R3/F2 (Phase 8.2): classify a sender-side error as a fatal sequence-space
 * exhaustion. The sender throws {@link FramingError} with code
 * {@link FramingErrorCode.SequenceExhausted} when either the per-session
 * sequence counter or the transfer-id allocator overflows UINT32. Both are
 * fatal: no further frames can be sent on this session, and any in-flight
 * transfer's chunks will never reach the receiver. The orchestrator + sender
 * cooperate to emit a {@link ControlSubtype.TransferCancel} so the receiver
 * drops its matching state.
 */
function isSequenceExhaustedError(err: unknown): boolean {
  if (err instanceof FramingError && err.code === FramingErrorCode.SequenceExhausted) {
    return true;
  }
  return false;
}

/**
 * LW-12 (Phase 7b): best-effort zeroize of a {@link SessionKeys} pair. Overwrites
 * the send and recv key bytes with zeros in place. JS-array zeroing is
 * best-effort — a copy retained by the GC or by the runtime's own buffer
 * management is not reached — but matching the receivedFiles precedent (Phase 4)
 * bounds the lifetime of the live key bytes to the framing layer's teardown.
 * Defense-in-depth; the authoritative key lifetime is the orchestrator's
 * teardownSession which nulls its SessionKeys reference.
 */
export function zeroizeSessionKeys(keys: SessionKeys): void {
  keys.sendKey.fill(0);
  keys.recvKey.fill(0);
}
