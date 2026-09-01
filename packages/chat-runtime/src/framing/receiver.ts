import { decryptFrame, ReplayWindow } from "../crypto/aead";
import { ctEqual } from "../crypto/ct-equal";
import { CryptoError } from "../crypto/errors";
import { decodeTransferCancelPayload } from "../protocol/codec";
import { MAX_CONCURRENT_TRANSFERS, MAX_INCOMPLETE_TRANSFER_BYTES } from "../protocol/limits";
import { ControlSubtype, CONTROL_SUBTYPE_VALUES, FrameType } from "../protocol/types";
import type { FrameAad } from "../protocol/types";

import { FramingError, FramingErrorCode } from "./errors";
import { chunkBoundaries, decodeManifest, sha256 } from "./manifest";
import type { FileManifest, FrameReceiverConfig, ReceivedFile } from "./types";
import { zeroizeSessionKeys } from "./sender";
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
  /**
   * Latch set the first time {@link FrameReceiver.dropTransfer} subtracts this
   * transfer's bytes from `totalBufferedBytes`. Subsequent drop calls (e.g. a
   * resumed `completeTransfer` reaching `dropTransfer` after `teardown` already
   * swept the map) become no-ops so the byte counter is never double-decremented.
   */
  dropped: boolean;
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
  /**
   * Latch set the moment {@link teardown} runs. Read FIRST by every public
   * entry point (`ingest`, `cancelTransfer`) and by the periodic sweep so a
   * teardown that races an in-flight `await sha256` cannot surface a stale
   * `onFileComplete`, double-decrement the byte counter, or re-arm a sweep
   * tick that `clearInterval` had already dispatched (R2:F2, R2:F4).
   */
  private tornDown = false;
  /**
   * Per-receiver promise chain that serializes {@link ingest}. The
   * orchestrator fires `ingest` re-entrantly from a per-message transport
   * callback with no serialization, and the body `await`s WebCrypto (decrypt,
   * sha256). Without chaining, two `ingest` calls interleave at every await
   * and corrupt the transfer map / byte counter (R2:F1, R2:F3, R2:F5). Each
   * call appends to the tail and returns its own promise so callers still
   * observe per-frame errors.
   */
  private ingestChain: Promise<void> = Promise.resolve();

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
    if (this.tornDown) return;
    const run = this.ingestChain.then(() => this._ingestSerialized(bytes));
    this.ingestChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * R2/F3 (Phase 7): cancel an inbound transfer and report whether one was
   * actually dropped. Returns `false` for an unknown id (no-op) — the caller
   * (the orchestrator) uses the return value to emit `onTransferCancelled`
   * exactly once and only for real cancellations.
   */
  cancelTransfer(transferId: number): boolean {
    if (this.tornDown) return false;
    const transfer = this.transfers.get(transferId);
    if (transfer === undefined) return false;
    this.dropTransfer(transferId, transfer);
    return true;
  }

  teardown(): void {
    // R2:F4: set the latch FIRST so any concurrently dispatched sweep tick,
    // in-flight `await sha256` resumption, or post-teardown `ingest` /
    // `cancelTransfer` short-circuits before touching shared state.
    this.tornDown = true;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    for (const [transferId, transfer] of this.transfers) {
      this.dropTransfer(transferId, transfer);
    }
    this.transfers.clear();
    // Drop the chain reference so a post-teardown `ingest` does not pin the
    // last frame's bytes through a queued microtask; `ingest` already
    // short-circuits on `tornDown`, so the tail never runs again.
    this.ingestChain = Promise.resolve();
    // LW-12 (Phase 7b): best-effort zeroize the session keys. See
    // {@link zeroizeSessionKeys} in sender.ts for the limitation rationale.
    zeroizeSessionKeys(this.config.sessionKeys);
  }

  private async _ingestSerialized(bytes: Uint8Array): Promise<void> {
    if (this.tornDown) return;
    const frame = decodeWireFrame(bytes);
    if (!ctEqual(frame.aad.senderSessionId, this.config.peerSessionId)) {
      throw new FramingError(
        FramingErrorCode.WrongSession,
        "sender session id does not match the expected peer session id",
      );
    }
    const plaintext = await this.decrypt(frame.aad, frame.nonce, frame.ciphertext);
    // Re-check after the decrypt await: a teardown (or a prior queued frame
    // that tore down) during the await must not surface plaintext to the host.
    if (this.tornDown) return;
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
    // R2:F4: an already-dispatched tick can fire after teardown ran
    // `clearInterval`. The `intervalId !== null` guard in teardown only blocks
    // re-arming; the latch closes this window.
    if (this.tornDown) return;
    const now = Date.now();
    for (const [transferId, transfer] of this.transfers) {
      if (now - transfer.lastActivity > this.inactivityTimeoutMs) {
        this.dropTransfer(transferId, transfer);
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
      dropped: false,
    };
    // R2:F5: re-check immediately before committing the map entry. Under the
    // serialized ingest the original race (a duplicate empty-file manifest
    // landing while the first awaits `completeTransfer`) cannot reopen, but
    // the check is a cheap defense against any future caller that bypasses the
    // chain.
    if (this.transfers.has(transferId)) {
      throw new FramingError(
        FramingErrorCode.TransferInactive,
        `transfer ${transferId} is already active`,
      );
    }
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
    // LW-4 (defense-in-depth): reject a non-canonical chunk length BEFORE the
    // hash check. The sender slices the file via the same `chunkBoundaries`
    // helper, so a canonical chunk's length must equal `end - start` for its
    // index. A mismatch here means either a malicious sender crafting a chunk
    // that reassembles to the declared size but with the wrong byte layout, or
    // a buggy sender slicing on different boundaries. Both would otherwise be
    // caught by the content-hash check at completion, but rejecting early
    // bounds the worst-case wasted buffering to one chunk and surfaces the
    // error at the offending frame rather than at reassembly.
    const { start, end } = chunkBoundaries(transfer.manifest.size, chunkId);
    const expectedLength = end - start;
    if (plaintext.length !== expectedLength) {
      throw new FramingError(
        FramingErrorCode.Malformed,
        `chunk ${chunkId} length ${plaintext.length} does not match canonical length ${expectedLength} for transfer ${transferId}`,
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
    if (!ctEqual(actualHash, transfer.manifest.contentHash)) {
      this.dropTransfer(transferId, transfer);
      throw new FramingError(
        FramingErrorCode.HashMismatch,
        `reassembled content hash does not match manifest for transfer ${transferId}`,
      );
    }
    // R2:F2: re-check after the sha256 await. A teardown that raced the await
    // has already swept the map and set `tornDown`; a parallel drop path
    // (e.g. a cancel that landed during the await) would have removed the
    // entry too. In any of those cases the transfer is no longer live and we
    // must not surface `onFileComplete` to a host that considers the receiver
    // gone. The success-path `dropTransfer` runs AFTER this check, so the
    // normal flow still sees the entry present.
    if (this.tornDown || !this.transfers.has(transferId)) {
      this.dropTransfer(transferId, transfer);
      return;
    }
    const file: ReceivedFile = { manifest: transfer.manifest, data: reassembled };
    this.dropTransfer(transferId, transfer);
    this.config.onFileComplete(file);
  }

  private dropTransfer(transferId: number, transfer: ActiveTransfer): void {
    // R2:F1: idempotent per transfer. A resumed `completeTransfer` reaching
    // `dropTransfer` after `teardown` (or a cancel) already subtracted must
    // not decrement `totalBufferedBytes` again — the resulting negative
    // counter would defeat every budget gate that reads it.
    if (transfer.dropped) return;
    transfer.dropped = true;
    this.totalBufferedBytes -= transfer.receivedBytes;
    this.transfers.delete(transferId);
  }
}
