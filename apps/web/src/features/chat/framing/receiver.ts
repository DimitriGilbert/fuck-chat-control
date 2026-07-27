import { decryptFrame, ReplayWindow } from "../crypto/aead";
import { CryptoError } from "../crypto/errors";
import { decodeTransferCancelPayload } from "../protocol/codec";
import { MAX_CONCURRENT_TRANSFERS, MAX_INCOMPLETE_TRANSFER_BYTES } from "../protocol/limits";
import { ControlSubtype, CONTROL_SUBTYPE_VALUES, FrameType } from "../protocol/types";
import type { FrameAad } from "../protocol/types";

import { FramingError, FramingErrorCode } from "./errors";
import { decodeManifest, sha256 } from "./manifest";
import type { FileManifest, FrameReceiverConfig, ReceivedFile } from "./types";
import { decodeWireFrame } from "./wire";

/**
 * Default inactivity timeout: a transfer that receives no chunk (or manifest)
 * for this long is evicted. Trade-off: a legitimately slow peer on a lossy
 * link may hit the timeout and have its transfer dropped even though it would
 * have eventually completed. The constants are exposed via
 * {@link FrameReceiverConfig.inactivityTimeoutMs} and
 * {@link FrameReceiverConfig.inactivityTickMs} so the orchestrator can tune
 * them for the deployment's expected link characteristics.
 */
const DEFAULT_TRANSFER_INACTIVITY_TIMEOUT_MS = 120_000;
const DEFAULT_TRANSFER_INACTIVITY_TICK_MS = 30_000;

interface ActiveTransfer {
  readonly manifest: FileManifest;
  readonly chunks: (Uint8Array | null)[];
  receivedCount: number;
  receivedBytes: number;
  /**
   * `Date.now()` captured at transfer creation and refreshed on every stored
   * chunk. Drives the periodic inactivity sweep so a silent peer cannot hold
   * buffer + transfer slots for the channel lifetime (CR-5).
   */
  lastActivity: number;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class FrameReceiver {
  private readonly config: FrameReceiverConfig;
  private readonly replayWindow = new ReplayWindow();
  private readonly transfers = new Map<number, ActiveTransfer>();
  private totalBufferedBytes = 0;
  private readonly inactivityTimeoutMs: number;
  private readonly inactivityTickMs: number;
  /**
   * Timer handle for the periodic inactivity sweep. Armed once in the
   * constructor and cleared in {@link teardown} to avoid leaks. Guarded
   * against double-arm/teardown by null-checking on clear. SSR/test safe:
   * Node ships timers, and tests that mock the clock via `vi.useFakeTimers`
   * drive the sweep through this same handle.
   */
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(config: FrameReceiverConfig) {
    this.config = config;
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_TRANSFER_INACTIVITY_TIMEOUT_MS;
    this.inactivityTickMs = config.inactivityTickMs ?? DEFAULT_TRANSFER_INACTIVITY_TICK_MS;
    this.intervalId = setInterval(() => this.sweepInactiveTransfers(), this.inactivityTickMs);
  }

  get activeTransferCount(): number {
    return this.transfers.size;
  }

  get bufferedBytes(): number {
    return this.totalBufferedBytes;
  }

  async ingest(bytes: Uint8Array): Promise<void> {
    const frame = decodeWireFrame(bytes);
    if (!bytesEqual(frame.aad.senderSessionId, this.config.peerSessionId)) {
      throw new FramingError(
        FramingErrorCode.WrongSession,
        "sender session id does not match the expected peer session id",
      );
    }
    const plaintext = await this.decrypt(frame.aad, frame.nonce, frame.ciphertext);
    switch (frame.aad.frameType) {
      case FrameType.Text:
        this.config.onText(plaintext);
        return;
      case FrameType.Control:
        this.handleControl(plaintext);
        return;
      case FrameType.FileManifest:
        await this.handleManifest(frame.aad.transferId, plaintext);
        return;
      case FrameType.FileChunk:
        await this.handleChunk(frame.aad.transferId, frame.aad.chunkId, plaintext);
        return;
      default:
        throw new FramingError(
          FramingErrorCode.Malformed,
          `unsupported frame type 0x${frame.aad.frameType.toString(16)}`,
        );
    }
  }

  cancelTransfer(transferId: number): void {
    const transfer = this.transfers.get(transferId);
    if (transfer === undefined) return;
    this.totalBufferedBytes -= transfer.receivedBytes;
    this.transfers.delete(transferId);
  }

  teardown(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    for (const transfer of this.transfers.values()) {
      this.totalBufferedBytes -= transfer.receivedBytes;
    }
    this.transfers.clear();
  }

  private async decrypt(
    aad: FrameAad,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    try {
      return await decryptFrame(
        this.config.sessionKeys.recvKey,
        this.replayWindow,
        aad,
        nonce,
        ciphertext,
      );
    } catch (err) {
      if (err instanceof CryptoError) {
        throw new FramingError(FramingErrorCode.Malformed, err.message);
      }
      throw err;
    }
  }

  private handleControl(plaintext: Uint8Array): void {
    if (plaintext.length === 0) {
      throw new FramingError(FramingErrorCode.Malformed, "control payload is empty");
    }
    const subtypeByte = plaintext[0];
    if (!CONTROL_SUBTYPE_VALUES.includes(subtypeByte as ControlSubtype)) {
      throw new FramingError(
        FramingErrorCode.UnknownControlSubtype,
        `unknown control subtype 0x${subtypeByte.toString(16)}`,
      );
    }
    const subtype = subtypeByte as ControlSubtype;
    const payload = plaintext.subarray(1);
    // R3/F2 (Phase 8.2): the sender-side abort signal is handled inline (not
    // routed through onControl) because the receiver is the authoritative
    // owner of inbound transfer state and the cancel must always drop the
    // matching entry, even if the host application has no other use for the
    // control event. The payload carries the 4-byte transferId.
    if (subtype === ControlSubtype.TransferCancel) {
      const transferId = decodeTransferCancelPayload(payload);
      this.cancelTransfer(transferId);
      return;
    }
    this.config.onControl(subtype, payload);
  }

  /**
   * Periodic sweep (CR-5) armed in the constructor and cleared in
   * {@link teardown}. Evicts any transfer whose `Date.now() - lastActivity`
   * exceeds {@link FrameReceiverConfig#inactivityTimeoutMs}, releasing its
   * buffered bytes and surfacing the eviction via `onTransferTimeout`. A
   * legitimately slow peer may hit this timeout; the constants are
   * configurable to tune the trade-off.
   */
  private sweepInactiveTransfers(): void {
    const now = Date.now();
    for (const [transferId, transfer] of this.transfers) {
      if (now - transfer.lastActivity > this.inactivityTimeoutMs) {
        this.totalBufferedBytes -= transfer.receivedBytes;
        this.transfers.delete(transferId);
        this.config.onTransferTimeout?.(transferId);
      }
    }
  }

  private async handleManifest(transferId: number, plaintext: Uint8Array): Promise<void> {
    const manifest = decodeManifest(plaintext, transferId);
    if (this.transfers.has(transferId)) {
      throw new FramingError(
        FramingErrorCode.TransferInactive,
        `transfer ${transferId} is already active`,
      );
    }
    if (this.transfers.size >= MAX_CONCURRENT_TRANSFERS) {
      throw new FramingError(
        FramingErrorCode.ConcurrentTransfersExceeded,
        `concurrent transfer limit (${MAX_CONCURRENT_TRANSFERS}) reached`,
      );
    }
    if (this.totalBufferedBytes + manifest.size > MAX_INCOMPLETE_TRANSFER_BYTES) {
      throw new FramingError(
        FramingErrorCode.SizeExceeded,
        `transfer size ${manifest.size} would exceed incomplete-transfer budget (${MAX_INCOMPLETE_TRANSFER_BYTES})`,
      );
    }
    const chunks: (Uint8Array | null)[] =
      manifest.chunkCount === 0 ? [] : Array.from({ length: manifest.chunkCount }, () => null);
    const transfer: ActiveTransfer = {
      manifest,
      chunks,
      receivedCount: 0,
      receivedBytes: 0,
      lastActivity: Date.now(),
    };
    this.transfers.set(transferId, transfer);
    if (manifest.chunkCount === 0) {
      await this.completeTransfer(transferId, transfer);
    }
  }

  private async handleChunk(
    transferId: number,
    chunkId: number,
    plaintext: Uint8Array,
  ): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (transfer === undefined) {
      throw new FramingError(
        FramingErrorCode.UnknownTransfer,
        `chunk for unknown or inactive transfer ${transferId}`,
      );
    }
    if (chunkId < 0 || chunkId >= transfer.manifest.chunkCount) {
      throw new FramingError(
        FramingErrorCode.ChunkOutOfRange,
        `chunk ${chunkId} out of range [0, ${transfer.manifest.chunkCount})`,
      );
    }
    if (transfer.chunks[chunkId] !== null) {
      throw new FramingError(
        FramingErrorCode.DuplicateChunk,
        `chunk ${chunkId} already received for transfer ${transferId}`,
      );
    }
    const projectedReceived = transfer.receivedBytes + plaintext.length;
    if (projectedReceived > transfer.manifest.size) {
      throw new FramingError(
        FramingErrorCode.SizeExceeded,
        `chunk ${chunkId} would exceed declared size ${transfer.manifest.size}`,
      );
    }
    if (this.totalBufferedBytes + plaintext.length > MAX_INCOMPLETE_TRANSFER_BYTES) {
      throw new FramingError(
        FramingErrorCode.SizeExceeded,
        `chunk would exceed incomplete-transfer budget (${MAX_INCOMPLETE_TRANSFER_BYTES})`,
      );
    }
    transfer.chunks[chunkId] = plaintext;
    transfer.receivedCount += 1;
    transfer.receivedBytes += plaintext.length;
    transfer.lastActivity = Date.now();
    this.totalBufferedBytes += plaintext.length;

    if (transfer.receivedCount === transfer.manifest.chunkCount) {
      await this.completeTransfer(transferId, transfer);
    }
  }

  private async completeTransfer(transferId: number, transfer: ActiveTransfer): Promise<void> {
    const reassembled = new Uint8Array(transfer.manifest.size);
    let offset = 0;
    for (let i = 0; i < transfer.manifest.chunkCount; i++) {
      const chunk = transfer.chunks[i];
      if (chunk === null) {
        this.dropTransfer(transferId, transfer);
        throw new FramingError(
          FramingErrorCode.Malformed,
          `missing chunk ${i} during reassembly of transfer ${transferId}`,
        );
      }
      reassembled.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== transfer.manifest.size) {
      this.dropTransfer(transferId, transfer);
      throw new FramingError(
        FramingErrorCode.SizeExceeded,
        `reassembled length ${offset} does not match declared size ${transfer.manifest.size}`,
      );
    }
    const actualHash = await sha256(reassembled);
    if (!bytesEqual(actualHash, transfer.manifest.contentHash)) {
      this.dropTransfer(transferId, transfer);
      throw new FramingError(
        FramingErrorCode.HashMismatch,
        `reassembled content hash does not match manifest for transfer ${transferId}`,
      );
    }
    const file: ReceivedFile = { manifest: transfer.manifest, data: reassembled };
    this.dropTransfer(transferId, transfer);
    this.config.onFileComplete(file);
  }

  private dropTransfer(transferId: number, transfer: ActiveTransfer): void {
    this.totalBufferedBytes -= transfer.receivedBytes;
    this.transfers.delete(transferId);
  }
}
