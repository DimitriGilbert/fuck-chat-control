import { Button } from "@fuck-eu-chat-control/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@fuck-eu-chat-control/ui/components/sheet";
import { MenuIcon } from "lucide-react";
import * as React from "react";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { ChatView } from "@/features/chat/ui/chat-view";
import { EmptyState } from "@/features/chat/ui/empty-state";
import { Sidebar } from "@/features/chat/ui/sidebar";

/**
 * The application shell: a persistent left sidebar on desktop (>=768px) and
 * a main pane that shows either the active chat or an empty state.
 *
 * Layout strategy:
 *   - The shell fills the viewport (`h-svh`) and uses a flex row so the
 *     sidebar and main pane each own their own scroll.
 *   - Desktop (md+): the sidebar is rendered inline at a fixed comfortable
 *     width (300px). No horizontal overflow: the main pane is `flex-1
 *     min-w-0`.
 *   - Mobile (<md): the sidebar lives inside a Sheet drawer. A slim top bar
 *     in the main pane carries the hamburger toggle. The drawer's SheetContent
 *     takes the sidebar's full width on small screens.
 *
 * The shell itself does NOT switch on route; it reads `state.active` /
 * `state.activeConversationId` to decide between {@link ChatView} and
 * {@link EmptyState}. Invitation-hash joining stays in `routes/index.tsx`.
 */
export function AppShell(): React.ReactElement {
  const { state } = useChat();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Close the mobile drawer whenever the active conversation changes so
  // selecting a chat from the drawer shows it immediately in the main pane.
  const activeId = state.activeConversationId;
  const lastActiveRef = React.useRef<unknown>(activeId);
  React.useEffect(() => {
    if (lastActiveRef.current !== activeId) {
      lastActiveRef.current = activeId;
      setMobileOpen(false);
    }
  }, [activeId]);

  return (
    <div className="flex h-svh w-full min-w-0 overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar: persistent, md+ only. Renders its own settings trigger. */}
      <div className="hidden md:flex md:w-[300px] md:shrink-0 md:basis-[300px]">
        <Sidebar className="w-full" />
      </div>

      {/* Mobile sidebar: Sheet drawer, controlled by the top-bar hamburger.
          The Sheet itself renders no trigger; we drive it via `open`. */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[85vw] max-w-[320px] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Conversations</SheetTitle>
            <SheetDescription>Browse, start, and switch conversations.</SheetDescription>
          </SheetHeader>
          {/* The mobile drawer's sidebar hides its own settings trigger so the
              desktop instance stays the single source of truth for the sheet.
              The drawer is closed at desktop widths anyway. */}
          <Sidebar hideSettingsEntry />
        </SheetContent>
      </Sheet>

      {/* Main pane: owns its own scroll, never overflows horizontally */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar: only rendered below md. Slender so the chat keeps
            the room. The desktop sidebar already owns brand + actions. */}
        <div className="flex h-12 items-center gap-2 border-b border-border px-2 md:hidden">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open conversations"
            className="text-foreground hover:bg-muted"
            onClick={() => setMobileOpen(true)}
          >
            <MenuIcon />
          </Button>
          <span className="text-foreground text-sm font-medium tracking-tight">
            {activeId === null ? "fuck-chat-control" : "Conversation"}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {activeId === null ? (
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
