/**
 * App entry. IMPORT ORDER IS LOAD-BEARING (see
 * packages/chat-runtime/src/crypto/webcrypto-env.d.ts and the header of
 * src/chat/rn-crypto-polyfill.ts):
 *
 * The bare `./src/chat/rn-crypto-polyfill` import MUST be this file's first
 * import. Its module body runs react-native-quick-crypto's `install()` and
 * pins `globalThis.crypto` (subtle + getRandomValues) — Hermes ships no
 * WebCrypto, and chat-runtime's crypto modules (`primitives.ts`,
 * `export-bundle.ts`, `in-memory-repo.ts`, `orchestrator.ts`) call
 * `globalThis.crypto.subtle` directly at ~9 sites.
 *
 * The invariant is at MODULE-EVALUATION granularity, not call granularity:
 * `import` edges evaluate depth-first in source order, BEFORE the importing
 * module's own body. `@noble/hashes/crypto.js` — reached through
 * `mobile-chat-provider` → chat-runtime → `@noble/curves` — snapshots
 * `globalThis.crypto` into a module-scoped const when it first evaluates; a
 * snapshot taken before the polyfill runs stays `undefined` for the process
 * lifetime, and every `p256.utils.randomSecretKey()` then throws
 * `crypto.getRandomValues must be defined`. That is why the install lives
 * INSIDE the polyfill module's top-level statements and this file uses a
 * side-effect import: calling an installer from THIS module's body could
 * never run early enough, because every import below (including the whole
 * chat-runtime → noble graph) has already evaluated by then.
 */
import "./src/chat/rn-crypto-polyfill";

import {
  conversationIdToHex,
  hexToConversationId,
} from "@fuck-eu-chat-control/chat-runtime/orchestrator/invitation";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import * as React from "react";
import { StatusBar, StyleSheet, Text, View } from "react-native";

import { ChatProvider, useChat } from "./src/chat/mobile-chat-provider";
import { AppErrorBoundary } from "./src/error-boundary";
import { ChatScreen } from "./src/screens/chat-screen";
import { HomeScreen } from "./src/screens/home-screen";
import { JoinConversationScreen } from "./src/screens/join-conversation-screen";
import { StartConversationScreen } from "./src/screens/start-conversation-screen";
import { colors } from "./src/ui/colors";

type Route = "home" | "start" | "join" | "chat";

function Router(): React.ReactElement {
  const [route, setRoute] = React.useState<Route>("home");
  const [error, setError] = React.useState<string | null>(null);
  // `useChat()` (not `useChatController()`) because the provider has not turned
  // `ready` yet on the first render — `useChatController()` throws in that
  // window (mobile-chat-provider.tsx), which would crash Router before the
  // user ever sees the home screen. `controller` is null only until the
  // provider's async construction resolves; by the time `state.conversations`
  // populates enough to render a tappable row, it is non-null. The handler
  // below guards for the early window.
  const { controller, state, ready } = useChat();

  // R8/F2 (b): fail-closed navigation. The start/join/chat screens call
  // `useChatController()` during render, which throws while the provider is
  // still constructing (`!ready`) or after its fail-closed catch set
  // `state.error` with no controller. "home" must stay reachable in every
  // state so Back and Leave keep working.
  const canEnterChatSurfaces = ready && state.error === null;
  const navigate = React.useCallback(
    (next: Route) => {
      if (next !== "home" && !canEnterChatSurfaces) return;
      setRoute(next);
    },
    [canEnterChatSurfaces],
  );

  // Auto-switch to the chat screen once an active session is ready for it.
  // resumeConversation's emit(null) calls flip state.active non-null, so a
  // successful resume routes here even without an explicit setRoute('chat')
  // in the handler.
  //
  // R13F1: a freshly STARTED initiator session also flips state.active
  // non-null the moment it registers — while still Waiting for the
  // responder. Auto-routing to "chat" at that instant pulled the start
  // screen's invitation link + Share button out from under the initiator,
  // and the chat screen's only way back (Leave) tears the session down, so
  // the link was unreachable and the peer could never join. A session whose
  // invitation is still pending (invitation set, handshake not yet
  // Connected) therefore suppresses the auto-route entirely: the initiator
  // stays on the start screen and this effect routes to "chat" only when
  // the Connected snapshot lands — matching the screen's copy ("the chat
  // screen opens automatically once the handshake completes"). Responder
  // and resumed sessions carry no invitation and route on activation as
  // before.
  //
  // R8/F1: routing is tracked per conversation id (by hex value —
  // ConversationId is a branded Uint8Array, never compared by reference) so
  // a stale non-null `state.active` snapshot coexisting with route "home"
  // after Leave cannot force the route back into a chat the user just left.
  const routedActiveHexRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const active = state.active;
    if (active === null) {
      routedActiveHexRef.current = null;
      return;
    }
    if (active.invitation !== null && active.connectionState !== ConnectionState.Connected) {
      return;
    }
    const activeHex = conversationIdToHex(active.id);
    if (route === "chat" || routedActiveHexRef.current === activeHex) {
      routedActiveHexRef.current = activeHex;
      return;
    }
    routedActiveHexRef.current = activeHex;
    setRoute("chat");
  }, [state.active, route]);

  const handleOpen = React.useCallback(
    (hex: string) => {
      if (controller === null) return;
      setError(null);
      let id: ConversationId;
      try {
        id = hexToConversationId(hex);
      } catch (err: unknown) {
        // Redact internal detail (the OrchestratorError message embeds the
        // expected fragment shape) from the user-visible error bar. The
        // original is kept for diagnostics.
        console.warn("hexToConversationId failed", err);
        setError("That conversation link could not be read.");
        return;
      }
      // resumeConversation handles BOTH the live-session case (cheap select,
      // no re-handshake) and the persisted-only case (re-enter via startSession
      // with history seeding). Do NOT call selectConversation first — it throws
      // for non-live ids.
      void controller
        .resumeConversation(id)
        .then(() => {
          // R13F1: re-selecting a still-LIVE initiator session that is waiting
          // for its peer keeps that session's pending invitation. The
          // auto-route effect deliberately does not move such a session to
          // "chat" (that would strand the link behind Leave), so re-enter the
          // start screen — its invitation view renders the pending link +
          // Share button from state.active.
          const active = controller.getState().active;
          if (
            active !== null &&
            active.invitation !== null &&
            active.connectionState !== ConnectionState.Connected
          ) {
            navigate("start");
          }
        })
        .catch((err: unknown) => {
          // Upstream throws leak internal identifiers (e.g. unknown conversation
          // id, broker/turn URLs, SDP from transport errors). Surface a generic
          // message; keep the original for diagnostics only.
          console.warn("resumeConversation failed", err);
          setError("Could not resume the conversation.");
        });
    },
    [controller, navigate],
  );

  let screen: React.ReactElement;
  switch (route) {
    case "home":
      screen = (
        <HomeScreen
          onStart={() => navigate("start")}
          onJoin={() => navigate("join")}
          onOpen={handleOpen}
        />
      );
      break;
    case "start":
      screen = <StartConversationScreen onBack={() => navigate("home")} />;
      break;
    case "join":
      screen = (
        <JoinConversationScreen onJoined={() => navigate("chat")} onBack={() => navigate("home")} />
      );
      break;
    case "chat":
      screen = <ChatScreen onLeave={() => navigate("home")} />;
      break;
  }

  // R8/F2: the bar surfaces BOTH Router-local errors (handleOpen failures)
  // and the provider/controller state error. The local message wins when both
  // exist; both strings are already redacted at their source.
  const banner = error ?? state.error;

  return (
    <View style={styles.root}>
      {screen}
      {banner !== null ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{banner}</Text>
        </View>
      ) : null}
    </View>
  );
}

export default function App(): React.ReactElement {
  return (
    <AppErrorBoundary>
      <ChatProvider>
        <StatusBar barStyle="light-content" />
        <Router />
      </ChatProvider>
    </AppErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  errorBar: {
    backgroundColor: colors.danger,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorText: { color: colors.text, fontSize: 13 },
});
