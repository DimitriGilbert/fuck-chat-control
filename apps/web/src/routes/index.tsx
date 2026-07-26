import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { AppShell } from "@/features/chat/ui/app-shell";
import { readInvitationFragment } from "@/features/chat/ui/invitation-fragment";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

/**
 * The home route renders the app shell. The shell decides what the main pane
 * shows (active chat vs empty state) based on `state.activeConversationId`.
 *
 * Invitation-hash joining still runs here: once the controller is ready, we
 * look for `#<hex>` in the URL fragment and call `controller.joinConversation`.
 * The hash never reaches the server (browsers withhold it), so this only runs
 * in the browser. `hashchange` covers the case of a user pasting an invitation
 * link into an already-open tab.
 */
function HomeComponent(): React.ReactElement {
  const { controller, state, ready } = useChat();
  const joinedRef = React.useRef(false);

  // Gate on the active id rather than the deprecated flat mirror: the active
  // session is what the shell renders, so once it is non-null we stop trying
  // to join from the fragment.
  const activeId = state.activeConversationId;

  const tryJoin = React.useCallback(() => {
    if (!ready || controller === null) return;
    if (joinedRef.current) return;
    if (activeId !== null) {
      joinedRef.current = true;
      return;
    }
    if (typeof window === "undefined") return;
    const fragment = readInvitationFragment(window.location.hash);
    if (fragment === null) return;
    joinedRef.current = true;
    void controller.joinConversation(fragment).catch((err: unknown) => {
      toast.error("Could not join conversation", {
        description: err instanceof Error ? err.message : String(err),
      });
      // Clear the malformed hash so a refresh does not re-trigger.
      if (window.history !== undefined) {
        window.history.replaceState(null, "", window.location.pathname);
      }
    });
  }, [ready, controller, activeId]);

  React.useEffect(() => {
    tryJoin();
  }, [tryJoin]);

  // A user already on `/` who then opens an invitation link (same path, only
  // the hash changes) would not re-trigger the effect above because its deps
  // do not include the raw hash string. Listen for `hashchange` so a
  // late-arriving fragment is honored.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    function onHashChange(): void {
      tryJoin();
    }
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [tryJoin]);

  return <AppShell />;
}
