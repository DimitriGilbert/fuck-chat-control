export const FrameType = {
  Text: 0x01,
  FileManifest: 0x02,
  FileChunk: 0x03,
  Control: 0x04,
  MediaManifest: 0x05,
  MediaChunk: 0x06,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const FRAME_TYPE_VALUES: readonly FrameType[] = [
  FrameType.Text,
  FrameType.FileManifest,
  FrameType.FileChunk,
  FrameType.Control,
  FrameType.MediaManifest,
  FrameType.MediaChunk,
];

export const ControlSubtype = {
  SessionKeyExchange: 0x01,
  IdentityAnnouncement: 0x02,
  Leave: 0x03,
  SafetyNumberAnnouncement: 0x04,
} as const;
export type ControlSubtype = (typeof ControlSubtype)[keyof typeof ControlSubtype];

export const CONTROL_SUBTYPE_VALUES: readonly ControlSubtype[] = [
  ControlSubtype.SessionKeyExchange,
  ControlSubtype.IdentityAnnouncement,
  ControlSubtype.Leave,
  ControlSubtype.SafetyNumberAnnouncement,
];

export const Role = {
  Initiator: "initiator",
  Responder: "responder",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const AuthMode = {
  SafetyNumberOnly: 0x01,
} as const;
export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode];

export const AUTH_MODE_VALUES: readonly AuthMode[] = [AuthMode.SafetyNumberOnly];

declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & {
  readonly [__brand]: B;
};

export type ConversationId = Brand<Uint8Array, "ConversationId">;
export type SessionId = Brand<Uint8Array, "SessionId">;
export type PublicKey = Brand<Uint8Array, "PublicKey">;
export type Signature = Brand<Uint8Array, "Signature">;

export type Sequence = number;

export interface FrameAad {
  readonly protocolVersion: number;
  readonly senderSessionId: SessionId;
  readonly senderSequence: Sequence;
  readonly frameType: FrameType;
  readonly transferId: number;
  readonly chunkId: number;
}

export interface FrameHeader extends FrameAad {
  readonly ciphertextLength: number;
}

export interface Transcript {
  readonly transcriptVersion: number;
  readonly protocolVersion: number;
  readonly conversationId: ConversationId;
  readonly authMode: AuthMode;
  readonly initiatorIdentityKey: PublicKey;
  readonly responderIdentityKey: PublicKey;
  readonly initiatorEphemeralKey: PublicKey;
  readonly responderEphemeralKey: PublicKey;
  readonly initiatorSessionId: SessionId;
  readonly responderSessionId: SessionId;
}
