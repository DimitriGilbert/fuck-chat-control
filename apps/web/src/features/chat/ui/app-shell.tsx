import { Button } from "@fuck-eu-chat-control/ui/components/button";
import { cn } from "@fuck-eu-chat-control/ui/lib/utils";
import { ChevronLeftIcon } from "lucide-react";
import * as React from "react";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { ChatView } from "@/features/chat/ui/chat-view";
import { GroupView } from "@/features/chat/ui/group-view";
import { EmptyState, SecurityStory } from "@/features/chat/ui/empty-state";
import { Sidebar } from "@/features/chat/ui/sidebar";
import { TESTIDS } from "@/features/chat/ui/testids";
import { conversationIdKey } from "@/features/chat/ui/unified-sessions";

/**
 * The application shell, in two responsive modes:
 *
 *   - Desktop (md+): a persistent left sidebar plus a main pane that shows
 *     the active chat or the empty state.
 *   - Mobile (<md): conversation list FIRST — the full-width sidebar rail is
 *     the home surface (brand, CTA, list, settings). Opening a conversation
 *     pushes the chat pane over it as a fixed overlay; a "Chats" back button
 *     returns to the list WITHOUT leaving the session (it stays connected
 *     and keeps accruing unread).
 *
 * The main pane is a SINGLE mounted element in both modes (CSS repositions
 * it): on desktop it sits in flow; on mobile it is `hidden` until a chat is
 * open, then becomes `fixed inset-0` over the list. Keeping one mount means
 * the composer, scroll position, and drag-drop handlers exist exactly once
 * per breakpoint class.
 *
 * The shell itself does NOT switch on route; it reads
 * `state.activeConversationId` to decide between {@link ChatView} and
 * {@link EmptyState}. Invitation-hash joining stays in routes/index.tsx.
 */
export function AppShell(): React.ReactElement {
  const { state } = useChat();
  const activeId = state.activeConversationId;
  // The controller keeps the two selections mutually exclusive, so at most
  // one of these is non-null; the group branch wins defensively if both ever
  // were (e.g. a stale pre-v2 snapshot).
  const activeGroup = state.activeGroup;

  // Mobile overlay dismissal. `chatHidden` only affects <md: the back button
  // sets it (list visible, session stays live); any active-surface change
  // clears it so joining/opening a chat always reveals it. Selecting a row
  // also clears it via the sidebar's onSessionOpen.
  const [chatHidden, setChatHidden] = React.useState(false);
  // Composite "which surface" key, not a boolean — EVERY active-surface
  // change must fire the reveal: none↔some AND A→B, including
  // conversation↔group switches. A bare boolean would miss e.g. tapping
  // "Start a conversation" while a chat was open-but-hidden (the old
  // surface stays active until the new one activates — true→true, no
  // transition). The c:/g: prefixes match buildUnifiedList's namespace
  // split (both kinds share the 16-byte id space).
  const activeKey =
    activeGroup !== null
      ? `g:${activeGroup.groupIdHex}`
      : activeId === null
        ? ""
        : `c:${conversationIdKey(activeId)}`;
  const lastActiveRef = React.useRef(activeKey);
  React.useEffect(() => {
    if (lastActiveRef.current !== activeKey) {
      lastActiveRef.current = activeKey;
      setChatHidden(false);
    }
  }, [activeKey]);

  const mobileChatOpen = activeKey !== "" && !chatHidden;

  return (
    <div className="relative flex h-svh w-full min-w-0 overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar: persistent rail, md+ only. */}
      <div className="hidden md:flex md:w-[300px] md:shrink-0 md:basis-[300px]">
        <Sidebar className="w-full" />
      </div>

      {/* Mobile home: the conversation list IS the first screen. Same Sidebar
          composition as the rail — one list implementation — with the
          first-run security story in its empty slot and a labeled settings
          entry. */}
      <div className="flex min-w-0 flex-1 md:hidden">
        <Sidebar
          className="border-r-0"
          startTestId={TESTIDS.startConversationMobile}
          listTestId={TESTIDS.conversationList}
          settingsLabel
          onSessionOpen={() => setChatHidden(false)}
          emptyContent={
            <div className="px-1 py-4">
              <SecurityStory align="start" />
            </div>
          }
        />
      </div>

      {/* Main pane: in-flow on desktop; on mobile a fixed overlay that pushes
          over the list while a chat is open. `hidden md:flex` when closed
          keeps it mounted (transfers/state stay warm) but offscreen.
          The slide-in animation re-runs whenever the pane flips from
          display:none to rendered — the "push over" effect, free. */}
      <main
        className={cn(
          "min-w-0 flex-col bg-background",
          mobileChatOpen
            ? "motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200 fixed inset-0 z-30 flex md:static md:z-auto md:flex-1"
            : "hidden md:flex md:flex-1",
        )}
      >
        {/* Mobile back bar: returns to the list, does NOT leave the session. */}
        <div className="flex h-12 items-center gap-1 border-b border-border px-2 md:hidden">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChatHidden(true)}
            data-testid={TESTIDS.backToConversations}
            aria-label="Back to conversations"
          >
            <ChevronLeftIcon />
            Chats
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {activeGroup !== null ? (
            <GroupView />
          ) : activeId === null ? (
            <div className="h-full overflow-y-auto">
              <EmptyState />
            </div>
          ) : (
            <ChatView />
          )}
        </div>
      </main>
    </div>
  );
}
