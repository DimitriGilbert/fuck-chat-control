/**
 * Re-export of the platform-neutral {@link PeerTransport} contract and
 * {@link toPeerTransport} adapter, whose canonical definitions now live in
 * `@fuck-eu-chat-control/chat-runtime` (`packages/chat-runtime/src/transport`).
 *
 * Historically this file owned those definitions and reached into the
 * web-only `webrtc-adapter` for `DataChannelTransport`, which created a
 * circular dependency once the runtime core moves into the chat-runtime
 * package. The neutral types now live with the runtime; the adapter there
 * is generic over the {@link DataChannelTransport} interface.
 *
 * The chat-runtime package alias is not wired into `apps/web/tsconfig.json`
 * yet (that lands in sub-phase A.7), so this module imports via a relative
 * path. A.7 will swap the relative path for the
 * `@fuck-eu-chat-control/chat-runtime` alias and consumers will be free to
 * import directly from the package.
 */
export { toPeerTransport } from "../../../../../../packages/chat-runtime/src/transport/peer-transport";
export type { PeerTransport } from "../../../../../../packages/chat-runtime/src/transport/peer-transport";
