import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import type { ConversationId } from "@/features/chat/protocol/types";
import { ChatView } from "@/features/chat/ui/chat-view";
import { Landing } from "@/features/chat/ui/landing";
import { readInvitationFragment } from "@/features/chat/ui/invitation-fragment";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const { controller, state, ready } = useChat();
  const joinedRef = React.useRef(false);

  // Client-side: once the controller is ready, look for an invitation hash
  // and join the conversation it points at. The hash never reaches the
  // server (browsers withhold it), so this only runs in the browser.
  React.useEffect(() => {
    if (!ready || controller === null) return;
    if (joinedRef.current) return;
    if (state.conversationId !== null) {
      joinedRef.current = true;
      return;
    }
    const fragment = readInvitationFragment(window.location.hash);
    if (fragment === null) return;
    joinedRef.current = true;
    void controller.joinConversation(fragment).catch((err: unknown) => {
      toast.error("Could not join conversation", {
        description: err instanceof Error ? err.message : String(err),
      });
      // Clear the malformed hash so a refresh does not re-trigger.
      if (typeof window !== "undefined" && window.history !== undefined) {
        window.history.replaceState(null, "", window.location.pathname);
      }
    });
  }, [ready, controller, state.conversationId]);

  // A user already on `/` who then opens an invitation link (same path, only
  // the hash changes) would not re-trigger the effect above — its deps don't
  // include the hash. Listen for `hashchange` so a late-arriving fragment is
  // still honored. This mirrors how a real user pastes a link into the URL bar
  // of an already-open tab.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    function onHashChange(): void {
      if (joinedRef.current) return;
      if (!ready || controller === null) return;
      if (state.conversationId !== null) {
        joinedRef.current = true;
        return;
      }
      const fragment = readInvitationFragment(window.location.hash);
      if (fragment === null) return;
      joinedRef.current = true;
      void controller.joinConversation(fragment).catch((err: unknown) => {
        toast.error("Could not join conversation", {
          description: err instanceof Error ? err.message : String(err),
        });
        if (window.history !== undefined) {
          window.history.replaceState(null, "", window.location.pathname);
        }
      });
    }
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [ready, controller, state.conversationId]);

  function handleResume(conversationId: ConversationId): void {
    if (controller === null) return;
    void controller.resumeConversation(conversationId).catch((err: unknown) => {
      toast.error("Could not resume", {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }

  if (state.conversationId !== null) {
    return (
      <main className="min-h-0">
        <ChatView />
      </main>
    );
  }

  return (
    <main className="min-h-0 overflow-y-auto">
      <Landing onResume={(record) => handleResume(record.id)} />
    </main>
  );
}
