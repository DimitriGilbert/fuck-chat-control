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

import { ChatProvider, useChatState } from './src/chat/mobile-chat-provider';
import { ChatScreen } from './src/screens/chat-screen';
import { HomeScreen } from './src/screens/home-screen';
import { JoinConversationScreen } from './src/screens/join-conversation-screen';
import { StartConversationScreen } from './src/screens/start-conversation-screen';
import * as React from 'react';
import { StatusBar } from 'react-native';

type Route = 'home' | 'start' | 'join' | 'chat';

function Router(): React.ReactElement {
  const [route, setRoute] = React.useState<Route>('home');
  const state = useChatState();
  // Auto-switch to the chat screen once an active conversation exists and the
  // handshake begins producing messages or an invitation.
  React.useEffect(() => {
    if (state.active !== null && route !== 'chat') {
      setRoute('chat');
    }
  }, [state.active, route]);

  switch (route) {
    case 'home':
      return (
        <HomeScreen
          onStart={() => setRoute('start')}
          onJoin={() => setRoute('join')}
          onOpen={() => setRoute('chat')}
        />
      );
    case 'start':
      return (
        <StartConversationScreen
          onStarted={() => setRoute('chat')}
          onBack={() => setRoute('home')}
        />
      );
    case 'join':
      return (
        <JoinConversationScreen
          onJoined={() => setRoute('chat')}
          onBack={() => setRoute('home')}
        />
      );
    case 'chat':
      return <ChatScreen onLeave={() => setRoute('home')} />;
  }
}

export default function App(): React.ReactElement {
  return (
    <ChatProvider>
      <StatusBar barStyle="light-content" />
      <Router />
    </ChatProvider>
  );
}
