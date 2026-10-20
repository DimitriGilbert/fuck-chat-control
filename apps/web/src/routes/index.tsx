import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { AppShell } from "@/features/chat/ui/app-shell";
import { BootShell } from "@/features/chat/ui/boot-shell";
import { useInvitationJoin } from "@/features/chat/ui/use-invitation-join";

export const Route = createFileRoute("/")({
  component: HomeComponent,
  // The match stays suspended through the whole SSR pass, so whatever the
  // pending component renders IS the first paint. A static replica of the
  // shell beats the router's default spinner: users see the real layout +
  // copy instantly instead of ~2s of empty page.
  pendingComponent: BootShell,
});

/**
 * The home route renders the app shell. The shell decides what the main pane
 * shows (active chat vs empty state) based on `state.activeConversationId`.
 *
 * Invitation-hash joining runs in {@link useInvitationJoin} (extracted, same
 * semantics): once the controller is ready it looks for `#<hex>(~<code>)?`
 * in the URL fragment and calls `controller.joinConversation`. The
 * `/#frag` join contract is frozen — the link lands straight in the chat
 * shell, no separate landing route.
 */
function HomeComponent(): React.ReactElement {
  const { controller, state, ready } = useChat();
  useInvitationJoin(controller, ready, state.activeConversationId);
  return <AppShell />;
}
