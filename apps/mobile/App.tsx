/**
 * App entry. ORDERING IS LOAD-BEARING (see
 * packages/chat-runtime/src/crypto/webcrypto-env.d.ts):
 *
 *  1. `installCryptoPolyfill()` runs BEFORE any chat-runtime import is
 *     evaluated. It patches `globalThis.crypto.subtle` with the JSI-backed
 *     implementation from react-native-quick-crypto. chat-runtime's crypto
 *     modules (`primitives.ts`, `export-bundle.ts`, `in-memory-repo.ts`,
 *     `orchestrator.ts`) call `globalThis.crypto.subtle` directly at ~9 sites,
 *     and Hermes does NOT ship WebCrypto — without this call first, the first
 *     crypto operation throws `TypeError: Cannot read property 'subtle' of
 *     undefined`.
 *
 *  2. Only AFTER the polyfill do we import the chat provider (which transitively
 *     imports chat-runtime). The static `import` at the top of this file is
 *     hoisted by Metro/Babel, but the polyfill module ALSO imports only its own
 *     native binding (not chat-runtime), so its `install()` runs at module
 *     evaluation — before the chat-runtime imports deeper in the graph are
 *     reached. This is the same ordering the web app relies on (the browser's
 *     `globalThis.crypto` exists before any module loads); here we reproduce it
 *     by making `installCryptoPolyfill` the first import the bundler sees.
 *
 *     To prove the ordering holds under bundler hoisting: `rn-crypto-polyfill`
 *     imports only `react-native-quick-crypto` (a native module that does NOT
 *     transitively import chat-runtime). The chat-runtime import path starts at
 *     `mobile-chat-provider` (below). Module evaluation is depth-first in
 *     dependency order, so `rn-crypto-polyfill`'s body runs before
 *     `mobile-chat-provider`'s transitive chat-runtime graph is reached.
 */
import { installCryptoPolyfill } from './src/chat/rn-crypto-polyfill';

installCryptoPolyfill();

import { decodeConversationId } from '@fuck-eu-chat-control/chat-runtime/protocol/codec';
import type { ConversationId } from '@fuck-eu-chat-control/chat-runtime/protocol/types';
import * as React from 'react';
import { StatusBar, StyleSheet, Text, View } from 'react-native';

import { ChatProvider, useChat } from './src/chat/mobile-chat-provider';
import { ChatScreen } from './src/screens/chat-screen';
import { HomeScreen } from './src/screens/home-screen';
import { JoinConversationScreen } from './src/screens/join-conversation-screen';
import { StartConversationScreen } from './src/screens/start-conversation-screen';
import { colors } from './src/ui/colors';

type Route = 'home' | 'start' | 'join' | 'chat';

/**
 * Parse a hex-encoded ConversationId (as produced by HomeScreen's `toHex`)
 * back into a branded `ConversationId`. Delegates length + brand validation to
 * the runtime's canonical `decodeConversationId`; the hex→bytes step is local
 * because codec.ts exposes no hex-string helper.
 */
function hexToConversationId(hex: string): ConversationId {
  if (hex.length % 2 !== 0) {
    throw new Error(`conversation id hex must have even length, got ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`conversation id hex has a non-hex character at offset ${i * 2}`);
    }
    bytes[i] = byte;
  }
  return decodeConversationId(bytes);
}

function Router(): React.ReactElement {
  const [route, setRoute] = React.useState<Route>('home');
  const [error, setError] = React.useState<string | null>(null);
  // `useChat()` (not `useChatController()`) because the provider has not turned
  // `ready` yet on the first render — `useChatController()` throws in that
  // window (mobile-chat-provider.tsx:186-189), which would crash Router before
  // the user ever sees the home screen. `controller` is null only until the
  // provider's async construction resolves; by the time `state.conversations`
  // populates enough to render a tappable row, it is non-null. The handler
  // below guards for the early window.
  const { controller, state } = useChat();
  // Auto-switch to the chat screen once an active conversation exists and the
  // handshake begins producing messages or an invitation. resumeConversation's
  // emit(null) calls flip state.active non-null, so a successful resume routes
  // here even without an explicit setRoute('chat') in the handler.
  React.useEffect(() => {
    if (state.active !== null && route !== 'chat') {
      setRoute('chat');
    }
  }, [state.active, route]);

  const handleOpen = React.useCallback((hex: string) => {
    if (controller === null) return;
    setError(null);
    let id: ConversationId;
    try {
      id = hexToConversationId(hex);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    // resumeConversation handles BOTH the live-session case (cheap select,
    // no re-handshake) and the persisted-only case (re-enter via startSession
    // with history seeding). Do NOT call selectConversation first — it throws
    // for non-live ids.
    void controller.resumeConversation(id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [controller]);

  let screen: React.ReactElement;
  switch (route) {
    case 'home':
      screen = (
        <HomeScreen
          onStart={() => setRoute('start')}
          onJoin={() => setRoute('join')}
          onOpen={handleOpen}
        />
      );
      break;
    case 'start':
      screen = (
        <StartConversationScreen
          onStarted={() => setRoute('chat')}
          onBack={() => setRoute('home')}
        />
      );
      break;
    case 'join':
      screen = (
        <JoinConversationScreen
          onJoined={() => setRoute('chat')}
          onBack={() => setRoute('home')}
        />
      );
      break;
    case 'chat':
      screen = <ChatScreen onLeave={() => setRoute('home')} />;
      break;
  }

  return (
    <View style={styles.root}>
      {screen}
      {error !== null ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

export default function App(): React.ReactElement {
  return (
    <ChatProvider>
      <StatusBar barStyle="light-content" />
      <Router />
    </ChatProvider>
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
