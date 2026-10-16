export const FramingErrorCode = {
  Malformed: "malformed",
  WrongSession: "wrong_session",
  SequenceExhausted: "sequence_exhausted",
  UnknownTransfer: "unknown_transfer",
  TransferInactive: "transfer_inactive",
  DuplicateChunk: "duplicate_chunk",
  ChunkOutOfRange: "chunk_out_of_range",
  SizeExceeded: "size_exceeded",
  ConcurrentTransfersExceeded: "concurrent_transfers_exceeded",
  HashMismatch: "hash_mismatch",
  TransferCancelled: "transfer_cancelled",
  TearingDown: "tearing_down",
  Backpressured: "backpressured",
  UnknownControlSubtype: "unknown_control_subtype",
} as const;

export type FramingErrorCode = (typeof FramingErrorCode)[keyof typeof FramingErrorCode];

export class FramingError extends Error {
  readonly code: FramingErrorCode;
  /**
   * R3/F1: the transfer this error is scoped to, when the failure concerns a
   * single transfer. Set by every transfer-scoped throw site in the receiver
   * (and by the manifest codec, which knows the expected id) so the
   * orchestrator's per-transfer classifier can route the error to
   * `onTransferError` with a meaningful id. Undefined for wire-level failures
   * (Malformed/WrongSession/AEAD), which are session-fatal and carry no
   * transfer context.
   */
  readonly transferId?: number;

  constructor(code: FramingErrorCode, message: string, transferId?: number) {
    super(`${code}: ${message}`);
    this.name = "FramingError";
    this.code = code;
    this.transferId = transferId;
  }
}

/**
 * R3/F1 (per-transfer vs session-fatal classification). Framing errors whose
 * failure is scoped to a single transferId — admission limits, duplicate or
 * out-of-range chunks, exceeded budgets, content-hash mismatch — are
 * NON-fatal: the peer violated one transfer's contract, not the session's.
 * Wire-level violations (Malformed frames/AAD/AEAD failures, WrongSession,
 * UnknownControlSubtype) remain session-fatal because they indicate a hostile
 * or buggy peer at the protocol layer. The sender-side lifecycle codes
 * (TearingDown, TransferCancelled, Backpressured, SequenceExhausted) are never
 * produced by `FrameReceiver.ingest`, so they are not classified here.
 */
const PER_TRANSFER_FRAMING_CODES: ReadonlySet<FramingErrorCode> = new Set<FramingErrorCode>([
  FramingErrorCode.UnknownTransfer,
  FramingErrorCode.TransferInactive,
  FramingErrorCode.DuplicateChunk,
  FramingErrorCode.ChunkOutOfRange,
  FramingErrorCode.SizeExceeded,
  FramingErrorCode.ConcurrentTransfersExceeded,
  FramingErrorCode.HashMismatch,
]);

/**
 * R3/F1: true when `err` is a {@link FramingError} whose failure is scoped to
 * a single transfer — safe to surface as a per-transfer error event without
 * tearing the session down. False for wire-level/session-fatal codes and for
 * non-FramingError rejections (those stay on the fatal path).
 */
export function isPerTransferFramingError(err: unknown): err is FramingError {
  return err instanceof FramingError && PER_TRANSFER_FRAMING_CODES.has(err.code);
}
