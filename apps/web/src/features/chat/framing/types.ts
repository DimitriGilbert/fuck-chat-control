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
}

export interface FrameReceiverHandlers {
  onText(plaintext: Uint8Array): void;
  onControl(subtype: ControlSubtype, payload: Uint8Array): void;
  onFileComplete(file: ReceivedFile): void;
}

export interface FrameReceiverConfig extends FrameReceiverHandlers {
  readonly sessionKeys: SessionKeys;
  readonly peerSessionId: SessionId;
}
