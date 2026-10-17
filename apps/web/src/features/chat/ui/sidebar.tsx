import { cn } from "@fuck-eu-chat-control/ui/lib/utils";
import * as React from "react";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { ConversationList, StartConversationButton } from "@/features/chat/ui/session-list";
import { SettingsSheetTrigger } from "@/features/chat/ui/settings-sheet";
import { TESTIDS } from "@/features/chat/ui/testids";
import { buildUnifiedSessions } from "@/features/chat/ui/unified-sessions";

// Re-exported so existing imports ("@/features/chat/ui/sidebar") keep working
// after the extract-then-restyle moved the implementations into
// unified-sessions.ts and session-list.tsx. Tests pin these paths.
export { buildUnifiedSessions } from "@/features/chat/ui/unified-sessions";
export { DeleteConversationDialog } from "@/features/chat/ui/session-list";
export type { DeleteConversationDialogProps } from "@/features/chat/ui/session-list";

/**
 * Left rail of the app shell. Owns no layout of its own beyond its width and
 * the vertical column; the {@link AppShell} decides whether it is persisted
 * (desktop) or rendered as the mobile list-first home.
 *
 * All list behavior lives in session-list.tsx + unified-sessions.ts; this
 * component is pure composition: brand, CTA, unified conversation list,
 * settings entry.
 */
export interface SidebarProps {
  /** Optional className merged onto the root. */
  readonly className?: string;
  /**
   * When true, the sidebar hides its own Settings trigger (a second surface
   * may already host one; suppressing keeps one "Open settings" button
   * visible per breakpoint).
   */
  readonly hideSettingsEntry?: boolean;
  /**
   * Invoked after every row tap. The mobile shell passes a callback that
   * reveals the pushed-over chat pane.
   */
  readonly onSessionOpen?: () => void;
  /**
   * Rendered inside the scroll area when the list is empty — the mobile home
   * passes the first-run security story; the desktop rail keeps the default
   * quiet hint.
   */
  readonly emptyContent?: React.ReactNode;
  /** Test id for the start-conversation CTA and the list container. */
  readonly startTestId?: string;
  readonly listTestId?: string;
  /** Render the settings entry as a labeled row instead of an icon button. */
  readonly settingsLabel?: boolean;
}

export function Sidebar({
  className,
  hideSettingsEntry = false,
  onSessionOpen,
  emptyContent,
  startTestId = TESTIDS.startConversation,
  listTestId,
  settingsLabel = false,
}: SidebarProps): React.ReactElement {
  const { state } = useChat();
  // Unified list: the UNION of persisted conversations and live session
  // summaries (see {@link buildUnifiedSessions}). Live state (connection,
  // unread, preview) is merged in where a session exists; a live session whose
  // record was deleted still gets a row, so the two list surfaces can never
  // disagree about what is alive.
  const sorted = React.useMemo(
    () => buildUnifiedSessions(state.conversations, state.sessions),
    [state.sessions, state.conversations],
  );

  return (
    <aside
      data-slot="sidebar"
      className={cn(
        "bg-sidebar text-sidebar-foreground flex h-full min-h-0 w-full min-w-0 flex-col border-r border-sidebar-border",
        className,
      )}
    >
      {/* Top: brand + New conversation affordance */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <a
          href="/"
          className="text-sidebar-foreground text-sm font-semibold tracking-tight hover:opacity-80"
          aria-label="fuck-chat-control home"
        >
          <span className="text-sidebar-primary">fuck</span>
          <span className="text-sidebar-foreground">-chat-control</span>
        </a>
      </div>
      <div className="px-2 pb-2">
        <StartConversationButton testId={startTestId} />
      </div>

      {/* Middle: scrolls internally. The list itself is the <nav>; the
          first-run story (emptyContent) is not navigation and stays outside
          the landmark. The "Conversations" label is a quiet small-caps
          header: muted, xs, tracked. The gold accent is reserved for active
          state, the CTA, the focus ring, the unread badge, and the
          connection dot, never as a fill here. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {sorted.length === 0 ? (
          (emptyContent ?? (
            <p className="text-sidebar-foreground/60 px-3 py-6 text-center text-xs">
              No conversations yet. Start one to get a link.
            </p>
          ))
        ) : (
          <nav aria-label="Conversations">
            <h2 className="text-muted-foreground mb-1 px-2 text-xs font-medium uppercase tracking-wide">
              Conversations
            </h2>
            <ConversationList sessions={sorted} onSessionOpen={onSessionOpen} testId={listTestId} />
          </nav>
        )}
      </div>

      {/* Bottom: settings entry. The self-contained SettingsSheetTrigger owns
          its Sheet state and the trigger button; click opens the sheet.
          settingsLabel renders a labeled row (mobile rail) instead of the
          compact icon button. */}
      <div className="border-t border-sidebar-border px-2 py-2">
        {hideSettingsEntry ? null : <SettingsSheetTrigger withLabel={settingsLabel} />}
      </div>
    </aside>
  );
}
