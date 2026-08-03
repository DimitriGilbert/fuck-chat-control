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
// --- Why there is no `maxPayload` key here (verified) ---------------------
// The DoS finding R3:F1 calls for a WebSocket-level `maxPayload` so an
// oversized frame is rejected by `ws` *before* it is buffered. `ws`'s default
// `maxPayload` is 100 MiB, and the app-level cap
// (`BROKER_MESSAGE_MAX_BYTES = 16384` in
// packages/chat-runtime/src/broker/protocol.ts) runs POST-buffer on the
// decoded string, so it cannot be the load-bearing limit.
//
// In the INSTALLED nitro version (3.0.260610-beta) there is NO config key
// that forwards `serverOptions.maxPayload` to the `ws` `WebSocketServer`.
// Verified by reading nitro's shipped sources:
//   - dist/types/index.d.mts: `features.websocket` and `experimental.websocket`
//     are both `websocket?: boolean` — pure feature flags, no nested options.
//   - dist/presets/node/runtime/node-server.mjs, dist/presets/_nitro/runtime/
//     nitro-dev.mjs, dist/runtime/internal/vite/dev-entry.mjs ALL hardcode
//     `wsAdapter({ resolve: resolveWebsocketHooks })` with no options object.
// crossws 0.4.10's node adapter (node_modules/.../crossws/dist/_chunks/
// node.mjs) WOULD honor `options.serverOptions.maxPayload` (spread into
// `new WebSocketServer({ noServer: true, ...options.serverOptions })`), but
// nitro never passes one. So a real wire-level cap requires either a nitro
// upgrade (once it threads `serverOptions` through) or a patch to the preset.
// This file deliberately does NOT set a fake key that looks like it works.
//
// Defense-in-depth until then: the app-layer 16 KiB cap in protocol.ts, plus
// crossws's built-in idle ping/pong sweep (idleTimeout default 30s), bound the
// oversized-frame + slowloris amplification. A nitro upgrade / upstream PR is
// tracked as the follow-up to close the wire-level buffer gap.
export default defineConfig({
  features: {
    websocket: true,
  },
});
