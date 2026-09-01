/**
 * `@fuck-eu-chat-control/chat-runtime` root barrel.
 *
 * This sub-phase (A.1 scaffold + A.2 transport types) populates ONLY the
 * `transport/` surface. Later sub-phases (A.3-A.8) move broker, crypto,
 * framing, protocol, signaling state-machine, orchestrator, store, and
 * runtime modules into `src/` and re-export them here.
 */
export type {
  DataChannelTransport,
  IceCandidate,
  IceServer,
  PeerConnection,
  PeerConnectionFactory,
  PeerConnectionFactoryOptions,
  PeerConnectionHandlers,
  PeerConnectionState,
  SessionDescription,
} from "./transport/types";
export { toPeerTransport } from "./transport/peer-transport";
export type { PeerTransport } from "./transport/peer-transport";
