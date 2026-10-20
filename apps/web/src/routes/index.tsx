import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { AppShell } from "@/features/chat/ui/app-shell";
import { BootShell } from "@/features/chat/ui/boot-shell";
import { JoinModeDialog } from "@/features/chat/ui/join-mode-dialog";
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
 * shows (active chat, active group, or empty state) based on
 * `state.activeConversationId` / `state.activeGroupId` — mutually exclusive
 * selections maintained by the controller.
 *
 * Invitation-hash joining runs in {@link useInvitationJoin}: a detected
 * `#<hex>(~<code>)?` fragment becomes a pending join and the
 * {@link JoinModeDialog} asks the user whether to join it as a 1:1
 * conversation or a group — the link grammar is identical for both
 * (protocol-v2 §8), so the choice cannot come from the link bytes. The
 * `/#frag` join contract is frozen — the link lands straight in the chat
 * shell, no separate landing route.
 */
function HomeComponent(): React.ReactElement {
  const { controller, state, ready } = useChat();
  const pendingJoin = useInvitationJoin(
    controller,
    ready,
    state.activeConversationId,
    state.activeGroupId,
  );
  return (
    <>
      <AppShell />
      {pendingJoin !== null && <JoinModeDialog pending={pendingJoin} />}
    </>
  );
}
