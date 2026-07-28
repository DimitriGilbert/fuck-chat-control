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

  constructor(code: FramingErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "FramingError";
    this.code = code;
  }
}
