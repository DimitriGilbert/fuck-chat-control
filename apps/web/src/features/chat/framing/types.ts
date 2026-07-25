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
