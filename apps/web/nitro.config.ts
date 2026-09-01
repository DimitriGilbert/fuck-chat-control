import { defineConfig } from "nitro";

// R3/F1 (broker DoS hardening): make the WebSocket surface explicit at the
// config level. `features.websocket: true` is the supported, non-deprecated
// nitro key (the older `experimental.websocket` is deprecated in favor of it,
// per nitro's dist/types/index.d.mts). It is duplicated here on purpose even
// though the `nitro/vite` plugin in vite.config.ts also sets it: c12 merges
// nitro.config.ts with the inline plugin options, so keeping the flag in both
// places means this file is a self-documenting inventory of the WS surface
// rather than a silent dependency on vite.config.ts.
//
// --- Wire-level WebSocket maxPayload (R3/F1) -------------------------------
// The DoS finding R3/F1 calls for a WebSocket-level `maxPayload` so an
// oversized frame is rejected by `ws` *before* it is buffered. `ws`'s default
// `maxPayload` is 100 MiB, and the app-level cap
// (`BROKER_MESSAGE_MAX_BYTES = 16384` in
// packages/chat-runtime/src/broker/protocol.ts) runs POST-buffer on the
// decoded string, so it cannot be the load-bearing limit.
//
// nitro 3.0.260610-beta (the latest release) exposes NO config key that
// forwards `serverOptions.maxPayload` to the `ws` `WebSocketServer` (its
// node-server preset and vite dev-entry both hardcode
// `wsAdapter({ resolve })` with no options), while crossws 0.4.10 WOULD honor
// `options.serverOptions.maxPayload`. The wire-level cap is therefore
// enforced via a local pnpm patch of those two nitro files
// (patches/nitro@3.0.260610-beta.patch, registered in pnpm-workspace.yaml):
// both call sites now pass `serverOptions: { maxPayload }`, defaulting to
// 32 KiB (just above the 16 KiB app cap) and overridable/disablable via the
// NITRO_WS_MAX_PAYLOAD env var. Proven by the regression test in
// packages/chat-runtime/tests/integration/broker-ws.test.ts (an oversized
// frame gets the socket disconnected at the framing layer with close code
// 1009). Drop the patch when a nitro release threads serverOptions through.
export default defineConfig({
  features: {
    websocket: true,
  },
});
