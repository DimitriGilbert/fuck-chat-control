/**
 * react-native WebSocket adapter implementing {@link SignalingSocketFactory}.
 *
 * The chat-runtime signaling layer consumes a {@link SignalingSocket} (see
 * packages/chat-runtime/src/signaling/signaling-client.ts) with a DOM-like
 * shape: `readyState`, `send`, `close`, and `onopen`/`onmessage`/`onclose`/
 * `onerror` setter properties. RN's built-in `WebSocket` already exposes a
 * compatible surface (handler properties + readyState), with one difference:
 * the message handler receives a DOM `MessageEvent`-like object whose `.data`
 * carries the frame. We wrap it to deliver the `{ data }` payload the runtime
 * expects and to swallow the event argument on open/close/error.
 */
import type {
  SignalingSocket,
  SignalingSocketFactory,
} from "@fuck-eu-chat-control/chat-runtime/signaling/signaling-client";

interface RnWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * Adapt a react-native WebSocket to the SignalingSocket surface. The runtime's
 * setters receive nullary callbacks (open/close/error) or a `{ data }` reader
 * (message); we bridge the RN handler properties (which pass an event object)
 * to those nullary shapes.
 */
function adaptRnSocket(raw: RnWebSocketLike): SignalingSocket {
  return {
    get readyState(): number {
      return raw.readyState;
    },
    send(data: string): void {
      raw.send(data);
    },
    close(code?: number, reason?: string): void {
      raw.close(code, reason);
    },
    set onopen(value: (() => void) | null) {
      raw.onopen = value === null ? null : () => value();
    },
    set onmessage(value: ((event: { readonly data: string }) => void) | null) {
      raw.onmessage =
        value === null
          ? null
          : (event: { readonly data: unknown }): void => {
              // RN surfaces text frames as strings on `event.data`; binary
              // frames surface as ArrayBuffers. The broker only ever emits
              // text, so coerce non-strings defensively.
              const data = event.data;
              value({ data: typeof data === "string" ? data : String(data) });
            };
    },
    set onclose(value: (() => void) | null) {
      raw.onclose = value === null ? null : () => value();
    },
    set onerror(value: (() => void) | null) {
      raw.onerror = value === null ? null : () => value();
    },
  };
}

/**
 * SignalingSocketFactory over the RN built-in WebSocket. The runtime passes
 * the fully-resolved `wss://`/`ws://` broker URL; the factory constructs the
 * socket lazily so the connection is opened only when the signaling layer
 * connects.
 *
 * `WebSocket` is read lazily (inside the factory body) rather than captured at
 * module evaluation so tests can swap `globalThis.WebSocket` between cases
 * without reloading the module.
 */
export const rnSocketFactory: SignalingSocketFactory = (url: string): SignalingSocket => {
  const ws = new (
    globalThis as unknown as { WebSocket: new (url: string) => RnWebSocketLike }
  ).WebSocket(url);
  return adaptRnSocket(ws);
};
