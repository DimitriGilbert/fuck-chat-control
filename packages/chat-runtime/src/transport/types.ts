/**
 * Platform-neutral transport contracts for the chat runtime.
 *
 * These interfaces lift the WebRTC adapter's public surface out of the
 * DOM-coupled `RTCPeerConnection` / `RTCDataChannel` types so the runtime
 * core (orchestrator, framing, signaling state-machine) can be reused across
 * `apps/web`, `apps/desktop` (Tauri), and `apps/mobile` (Expo).
 *
 * The web adapter in `apps/web/src/features/chat/signaling/webrtc-adapter.ts`
 * implements these interfaces against the browser's native WebRTC; native
 * adapters will implement them against their platform's equivalents.
 *
 * Design rule: every member here is derived from the real web adapter /
 * bridge code — do NOT add fields that are not consumed today. When a new
 * platform needs a capability, add it here first, then implement it in each
 * adapter.
 */

/**
 * Send-only transport contract consumed by the framing layer
 * (`FrameSender`). Mirrors {@link DataChannelTransport}'s send-side members
 * one-for-one so any `DataChannelTransport` structurally satisfies it.
 *
 * The neutral `FrameTransport` definition lives with the framing types; this
 * declaration is duplicated here ONLY as a structural reference for readers
 * tracing the layering — the canonical type remains in
 * `apps/web/src/features/chat/framing/types.ts` until framing moves into
 * chat-runtime (later sub-phase).
 */
// (Intentionally no code here; framing types own FrameTransport.)

/** ICE server descriptor (STUN/TURN). Neutral replacement for `RTCIceServer`. */
export interface IceServer {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

/**
 * SDP session description. Neutral replacement for `RTCSessionDescriptionInit`.
 *
 * The `rollback` type is the perfect-negotiation primitive (see
 * `webrtc-bridge.ts`'s `setLocalDescription({ type: "rollback" })`) that
 * returns a connection to a stable state.
 */
export interface SessionDescription {
  readonly type: "offer" | "answer" | "rollback";
  readonly sdp?: string;
}

/**
 * Trickle-ICE candidate. Neutral replacement for `RTCIceCandidateInit`.
 *
 * `sdpMid` / `sdpMLineIndex` / `usernameFragment` mirror the WebIDL fields the
 * browser emits via `RTCPeerConnectionIceEvent.candidate.toJSON()`.
 */
export interface IceCandidate {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly usernameFragment?: string;
}

/**
 * Coarse peer-connection state. Neutral replacement for
 * `RTCPeerConnectionState`.
 *
 * The bridge treats `failed` and `closed` as fatal peer drops, `disconnected`
 * as transient (may self-heal during ICE renegotiation), and `connected` as
 * the trigger for `transportReady`.
 */
export type PeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

/**
 * Bidirectional byte transport over a single data channel.
 *
 * This is the neutral contract the runtime core depends on. It extends the
 * send-only framing {@link FrameTransport} surface (send + bufferedAmount +
 * ready + setDrainListener) with the receive and lifecycle members the
 * orchestrator needs during the handshake phase:
 * - {@link setOnMessage} delivers inbound bytes (plaintext handshake messages
 *   pre-handshake; rerouted to `FrameReceiver.ingest` post-handshake);
 * - {@link onOpen} is a one-shot signal the bridge uses to re-check
 *   transport-readiness, because `RTCPeerConnection` may report `connected`
 *   before the channel's `open` event fires;
 * - {@link close} releases all underlying listeners.
 *
 * The web adapter (`DataChannelTransport` class) implements this against
 * `RTCDataChannel`; native adapters implement it against their equivalents.
 */
export interface DataChannelTransport {
  readonly bufferedAmount: number;
  readonly ready: boolean;
  send(bytes: Uint8Array): void;
  setDrainListener(listener: (() => void) | null): void;
  setOnMessage(handler: ((bytes: Uint8Array) => void) | null): void;
  onOpen(listener: () => void): void;
  close(): void;
}

/**
 * Callbacks a {@link PeerConnection} fires on its consumer (the bridge).
 *
 * - {@link onIceCandidate} delivers a trickle candidate to relay over
 *   signaling (fired from the native `icecandidate` event);
 * - {@link onConnectionStateChange} forwards the coarse connection state;
 * - {@link onDataChannel} delivers the responder-side data channel.
 */
export interface PeerConnectionHandlers {
  readonly onIceCandidate?: (candidate: IceCandidate) => void;
  readonly onConnectionStateChange?: (state: PeerConnectionState) => void;
  readonly onDataChannel?: (transport: DataChannelTransport) => void;
}

/** Options passed to a {@link PeerConnectionFactory}. */
export interface PeerConnectionFactoryOptions extends PeerConnectionHandlers {
  /**
   * ICE servers for candidate gathering. Empty array = loopback-only (no
   * STUN/TURN). In production the operator configures their own
   * standards-compliant STUN listener; no third-party STUN is hardcoded.
   */
  readonly iceServers?: readonly IceServer[];
}

/**
 * A peer connection abstracted over the platform's WebRTC implementation.
 *
 * This is the neutral contract the bridge (and, after A.4, the injected
 * factory caller) depends on. The web adapter (`WebRtcAdapter` class)
 * implements it against `RTCPeerConnection`; native adapters implement it
 * against their platform's equivalents. The method set is exactly what the
 * perfect-negotiation bridge calls today — no more, no less.
 */
export interface PeerConnection {
  createOffer(): Promise<SessionDescription>;
  createAnswer(): Promise<SessionDescription>;
  setLocalDescription(description: SessionDescription): Promise<void>;
  setRemoteDescription(description: SessionDescription): Promise<void>;
  addIceCandidate(candidate: IceCandidate): Promise<void>;
  createDataChannel(): DataChannelTransport;
  readonly connectionState: PeerConnectionState;
  close(): void;
}

/**
 * Factory that constructs a {@link PeerConnection} for a given ICE
 * configuration and handler set. The runtime core calls this instead of
 * `new WebRtcAdapter(...)` so each app injects its own platform adapter.
 *
 * Injection of the factory into the bridge is a later sub-phase (A.4); this
 * type is declared now so the contract is fixed before the codemod.
 */
export type PeerConnectionFactory = (
  options: PeerConnectionFactoryOptions,
) => PeerConnection;
