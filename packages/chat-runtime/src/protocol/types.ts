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
  PakeShare: 0x05,
  /**
   * R3/F2 (Phase 8.2): a sender that aborts a transfer due to a sequence/
   * transfer-id space exhaustion (a fatal sender-side state error) emits this
   * control frame so the receiver can drop the matching inbound transfer
   * state instead of timing out waiting for chunks that will never arrive.
   * Payload: 4-byte big-endian transferId (matching the AAD's transferId
   * field, but carried redundantly so the receiver can correlate without
   * parsing the AAD).
   */
  TransferCancel: 0x06,
  /**
   * Group conversations (protocol-v2 §4.1): the author-signed, epoch-numbered
   * member list gossiped over pairwise group links. Payload:
   * `groupId(16) ‖ epoch(4BE) ‖ memberCount(1) ‖ memberEntry[] ‖ signature(64)`.
   * Valid on group links ONLY — on a pair-mode v1 link it is a terminal
   * protocol error, exactly like any other unlisted subtype. Gated behind the
   * sender/receiver `allowGroupControlSubtypes` opt-in, NOT the shared
   * {@link CONTROL_SUBTYPE_VALUES} acceptance set.
   */
  GroupMembership: 0x07,
  /**
   * Group conversations (protocol-v2 §4.1): a joiner sends this on an
   * established group link to ask for the current member list. Empty payload.
   * Same group-link-only acceptance rule as {@link ControlSubtype.GroupMembership}.
   */
  GroupMembershipRequest: 0x08,
} as const;
export type ControlSubtype = (typeof ControlSubtype)[keyof typeof ControlSubtype];

/**
 * The v1-only control-subtype acceptance set. Deliberately EXCLUDES the group
 * subtypes (0x07/0x08): a pair-mode v1 link must keep terminal-erroring on
 * them byte-for-byte as before. Group links additionally accept
 * {@link GROUP_CONTROL_SUBTYPE_VALUES} via an explicit opt-in flag.
 */
export const CONTROL_SUBTYPE_VALUES: readonly ControlSubtype[] = [
  ControlSubtype.SessionKeyExchange,
  ControlSubtype.IdentityAnnouncement,
  ControlSubtype.Leave,
  ControlSubtype.SafetyNumberAnnouncement,
  ControlSubtype.PakeShare,
  ControlSubtype.TransferCancel,
];

/**
 * The group-link-only control subtypes (protocol-v2 §4.1). Accepted by the
 * framing sender/receiver ONLY when the caller opted the conversation into
 * group mode (`allowGroupControlSubtypes`); otherwise both values remain a
 * terminal `UnknownControlSubtype` error.
 */
export const GROUP_CONTROL_SUBTYPE_VALUES: readonly ControlSubtype[] = [
  ControlSubtype.GroupMembership,
  ControlSubtype.GroupMembershipRequest,
];

export const Role = {
  Initiator: "initiator",
  Responder: "responder",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const AuthMode = {
  SafetyNumberOnly: 0x01,
  Pake: 0x02,
} as const;
export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode];

export const AUTH_MODE_VALUES: readonly AuthMode[] = [AuthMode.SafetyNumberOnly, AuthMode.Pake];

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
