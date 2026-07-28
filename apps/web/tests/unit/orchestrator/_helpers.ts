import type { SignalingSocketFactory } from "@fuck-eu-chat-control/chat-runtime/signaling/signaling-client";

/**
 * Web-local orchestrator test doubles for the tests that stay in apps/web
 * (the `webrtc-bridge*` tests reach across dirs via `../orchestrator/_helpers`).
 *
 * The canonical copy of these helpers now lives in the chat-runtime package
 * (`packages/chat-runtime/tests/unit/orchestrator/_helpers.ts`) for the neutral
 * tests that moved there. This file holds only the surface the web-only tests
 * still consume — `mockSocketFactory`, re-exported from the signaling helper
 * next door.
 */
export { MockSignalingSocket, parse } from "../signaling/_helpers";

/**
 * Build a {@link SignalingSocketFactory} that returns the supplied mock
 * socket. The orchestrator wires signaling through this factory on
 * `start()`/`join()`; tests use it to assert the broker `join` was sent and
 * to simulate peer-leave / socket-close.
 */
export function mockSocketFactory(socket: {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  set onopen(value: (() => void) | null);
  set onmessage(value: ((event: { readonly data: string }) => void) | null);
  set onclose(value: (() => void) | null);
  set onerror(value: (() => void) | null);
}): SignalingSocketFactory {
  return () => socket;
}
