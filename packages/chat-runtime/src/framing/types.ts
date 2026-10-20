import type { SessionKeys } from "../crypto/types";
import type { ControlSubtype, SessionId } from "../protocol/types";

export interface FrameTransport {
  send(bytes: Uint8Array): void;
  readonly bufferedAmount: number;
  readonly ready: boolean;
  setDrainListener(listener: (() => void) | null): void;
}

export interface FileManifest {
  readonly transferId: number;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly chunkCount: number;
  readonly contentHash: Uint8Array;
}

export interface ReceivedFile {
  readonly manifest: FileManifest;
  readonly data: Uint8Array;
}

export interface FrameSenderConfig {
  readonly sessionKeys: SessionKeys;
  readonly localSessionId: SessionId;
  readonly peerSessionId: SessionId;
  readonly transport: FrameTransport;
  /**
   * Fired once after the transfer id is allocated and the manifest has been
   * sent, before the chunk loop begins. Additive: callers that omit it see no
   * change. Used by the orchestrator to surface `onTransferStart`.
   */
  readonly onTransferStart?: (
    transferId: number,
    name: string,
    mimeType: string,
    size: number,
  ) => void;
  /**
   * Optional per-chunk progress signal. Invoked inside the chunk loop with the
   * transfer id, the cumulative plaintext bytes sent so far, and the total
   * size. Additive: existing callers that omit it see no change.
   */
  readonly onProgress?: (transferId: number, bytesTransferred: number, total: number) => void;
  /**
   * Opt-in group-link mode (protocol-v2 §4.1): when true, `sendControl` also
   * accepts the group control subtypes in `GROUP_CONTROL_SUBTYPE_VALUES`
   * (`group_membership` 0x07, `group_membership_request` 0x08). Defaults to
   * false — a pair-mode v1 link keeps terminal-erroring on them exactly as
   * before. Additive: callers that omit it see no change.
   */
  readonly allowGroupControlSubtypes?: boolean;
}

export interface FrameReceiverHandlers {
  onText(plaintext: Uint8Array): void;
  onControl(subtype: ControlSubtype, payload: Uint8Array): void;
  onFileComplete(file: ReceivedFile): void;
}

export interface FrameReceiverConfig extends FrameReceiverHandlers {
  readonly sessionKeys: SessionKeys;
  readonly peerSessionId: SessionId;
  /**
   * Invoked when the periodic inactivity sweep evicts a transfer that has not
   * received a manifest or chunk for {@link inactivityTimeoutMs}. Additive:
   * callers that omit it see no change (the transfer is still evicted and the
   * buffered bytes are still released). CR-5.
   */
  readonly onTransferTimeout?: (transferId: number) => void;
  /**
   * R3/F5: non-fatal notification that the host's `onFileComplete` callback
   * threw. By the time it fires the transfer has already been hash-verified,
   * reassembled, and dropped — a throwing host handler is an application bug,
   * not a wire violation, so the receiver contains it here instead of
   * rejecting `ingest` (which callers would treat as session-fatal).
   * Additive: callers that omit it silently drop the host error.
   */
  readonly onTransferError?: (transferId: number, error: unknown) => void;
  /**
   * R3/F5: non-fatal notification that the host's `onText` or `onControl`
   * callback threw — contained for the same reason as
   * {@link onTransferError}. The frame itself was authenticated and decoded
   * successfully; only the host's handler failed. Additive: callers that omit
   * it silently drop the host error.
   */
  readonly onError?: (error: unknown) => void;
  /**
   * Max wall-clock gap (ms) between activity events on a single transfer
   * before the sweep evicts it. Defaults to 120_000 (2 minutes). CR-5.
   */
  readonly inactivityTimeoutMs?: number;
  /**
   * Interval (ms) at which the inactivity sweep runs. Defaults to 30_000.
   * Each tick walks {@link FrameReceiver#activeTransferCount} entries. CR-5.
   */
  readonly inactivityTickMs?: number;
  /**
   * Opt-in group-link mode (protocol-v2 §4.1): when true, the control-subtype
   * acceptance check also admits `GROUP_CONTROL_SUBTYPE_VALUES`
   * (`group_membership` 0x07, `group_membership_request` 0x08), routed to the
   * host via `onControl` like any other subtype. Defaults to false — a
   * pair-mode v1 link keeps terminal-erroring on them byte-for-byte as
   * before. Additive: callers that omit it see no change.
   */
  readonly allowGroupControlSubtypes?: boolean;
}
