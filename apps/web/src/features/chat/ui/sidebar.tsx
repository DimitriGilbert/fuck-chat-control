import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fuck-eu-chat-control/ui/components/alert-dialog";
import { Button } from "@fuck-eu-chat-control/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fuck-eu-chat-control/ui/components/dropdown-menu";
import { cn } from "@fuck-eu-chat-control/ui/lib/utils";
import {
  CheckCheckIcon,
  LockIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { deriveSessionLabel } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import type { SessionSummary } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationRecord } from "@fuck-eu-chat-control/chat-runtime/store";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { CONNECTION_STATE_LABELS } from "@/features/chat/ui/chat-status";
import { SettingsSheetTrigger } from "@/features/chat/ui/settings-sheet";
import { sortSessions } from "@/features/chat/ui/sort-sessions";

/**
 * Left rail of the app shell. Owns no layout of its own beyond its width and
 * the vertical column; the {@link AppShell} decides whether it is persisted
 * (desktop) or rendered inside a mobile Sheet drawer.
 *
 * The sidebar reads `state.sessions` (Phase 1 multi-session surface), sorts
 * them with the pure {@link sortSessions} helper, and calls
 * `controller.selectConversation(id)` on click. The bottom of the rail hosts
 * the settings entry; the top hosts the New conversation affordance.
 */
export interface SidebarProps {
  /** Optional className merged onto the root (used by the mobile Sheet content). */
  readonly className?: string;
  /**
   * When true, the sidebar hides its own Settings trigger (the mobile drawer
   * renders this Sidebar inside a portal; the desktop Sidebar already hosts
   * the trigger, so suppressing it here keeps one "Open settings" button in
   * the DOM at any time).
   */
  readonly hideSettingsEntry?: boolean;
}

export function Sidebar({
  className,
  hideSettingsEntry = false,
}: SidebarProps): React.ReactElement {
  const { controller, state, ready } = useChat();
  // Unified list: the UNION of persisted conversations and live session
  // summaries (see {@link buildUnifiedSessions}). Live state (connection,
  // unread, preview) is merged in where a session exists; a live session whose
  // record was deleted still gets a row, so the sidebar and the center
  // "Previous conversations" list can never disagree about what is alive.
  const sorted = React.useMemo(
    () => buildUnifiedSessions(state.conversations, state.sessions),
    [state.sessions, state.conversations],
  );
  const activeId = state.activeConversationId;

  function handleStart(): void {
    if (controller === null) return;
    void controller.startConversation().catch((err: unknown) => {
      toast.error("Could not start", {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }

  function handleSelect(id: ConversationId): void {
    if (controller === null) return;
    if (id === activeId) return;
    // A row may be persisted-only (no live session). Selecting it must resume
    // rather than no-op, so left conversations are still openable from the list.
    const isLive = state.sessions.some((s) => sessionKey(s.id) === sessionKey(id));
    if (!isLive) {
      void controller.resumeConversation(id).catch((err: unknown) => {
        toast.error("Could not open", {
          description: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }
    try {
      controller.selectConversation(id);
    } catch (err: unknown) {
      toast.error("Could not open", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
        <Button
          variant="default"
          size="sm"
          className="w-full justify-start"
          onClick={handleStart}
          disabled={!ready}
        >
          <PlusIcon />
          Start a conversation
        </Button>
      </div>

      {/* Middle: conversation list, scrolls internally. The "Conversations"
          label is a quiet small-caps header: muted, xs, tracked. The gold
          accent is reserved for active state, the CTA, the focus ring, the
          unread badge, and the connection dot, never as a fill here. */}
      <nav
        aria-label="Conversations"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2"
      >
        {sorted.length === 0 ? (
          <p className="text-sidebar-foreground/60 px-3 py-6 text-center text-xs">
            No conversations yet. Start one to get a link.
          </p>
        ) : (
          <>
            <h2 className="text-muted-foreground mb-1 px-2 text-xs font-medium uppercase tracking-wide">
              Conversations
            </h2>
            <ul className="flex flex-col gap-0.5">
              {sorted.map((session) => (
                <li key={sessionKey(session.id)}>
                  <SessionRow
                    session={session}
                    active={session.id === activeId}
                    onSelect={() => handleSelect(session.id)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>

      {/* Bottom: settings entry. The self-contained SettingsSheetTrigger owns
          its Sheet state and the trigger button; click opens the sheet. */}
      <div className="border-t border-sidebar-border px-2 py-2">
        {hideSettingsEntry ? null : <SettingsSheetTrigger />}
      </div>
    </aside>
  );
}

/**
 * Clickable row in the sidebar list. Renders peer label, a connection-state
 * dot, last-message preview + relative timestamp, and an unread badge when > 0.
 * A trailing DropdownMenu exposes Rename / Leave / Delete conversation.
 */
interface SessionRowProps {
  readonly session: SessionSummary;
  readonly active: boolean;
  readonly onSelect: () => void;
}

function SessionRow({ session, active, onSelect }: SessionRowProps): React.ReactElement {
  const { controller } = useChat();
  // R7/F2: destructive delete is gated behind an explicit confirmation dialog
  // (DeleteConversationDialog below) — the dropdown item only opens it.
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const label = session.label;
  const preview = session.lastMessagePreview;
  const timestamp = session.lastMessageAt;
  const connected = session.connectionState === ConnectionState.Connected;
  const unread = session.unread;
  const verified = session.safetyNumberVerified;
  // SEC-4: PAKE-authenticated rows carry a lock glyph so users can tell which
  // sessions are PAKE-protected vs safety-number-only at a glance.
  const pakeProtected = session.authMode === AuthMode.Pake;

  async function handleRename(): Promise<void> {
    if (controller === null) return;
    // prompt() is browser-only; this handler is invoked from a click, so the
    // SSR contract is not violated.
    const next = window.prompt("Rename this conversation", label);
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === label) return;
    try {
      await controller.setDisplayName(session.id, trimmed);
    } catch (err: unknown) {
      toast.error("Could not rename", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleLeave(): void {
    if (controller === null) return;
    // Non-destructive: tears down the live session, keeps the persisted
    // record (same semantics as the EmptyState row's Leave).
    controller.leaveConversation(session.id);
  }

  return (
    <div
      data-slot="sidebar-row"
      data-active={active ? "true" : undefined}
      className={cn(
        "group/row relative flex items-stretch rounded-md transition-colors",
        active
          ? "bg-primary/10 text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/60 text-sidebar-foreground",
      )}
    >
      {/* Active rail: bright primary left edge, the one place gold reads as a
          marker on the row itself (along with the connection dot when live). */}
      {active && (
        <span
          aria-hidden="true"
          className="bg-primary absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full"
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2.5 text-left"
        aria-current={active ? "true" : undefined}
      >
        <span className="flex items-center gap-1.5">
          <ConnectionDot connected={connected} />
          <span className="truncate text-sm font-medium">{label}</span>
          {pakeProtected && (
            <LockIcon
              className="text-sidebar-primary size-3.5 shrink-0"
              aria-label="PAKE-authenticated session"
            />
          )}
          {verified && (
            <CheckCheckIcon
              className="text-sidebar-primary size-3.5 shrink-0"
              aria-label="Safety number verified"
            />
          )}
          {unread > 0 && (
            <span
              aria-label={`${unread} unread`}
              className="bg-primary text-primary-foreground ml-auto inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground truncate flex-1">
            {preview ?? placeholderForState(session.connectionState)}
          </span>
          <Timestamp timestamp={timestamp} connected={connected} />
        </span>
      </button>
      <div className="flex items-start pr-1 pt-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-sidebar-foreground/70 hover:text-sidebar-foreground"
                aria-label={`Actions for ${label}`}
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onClick={() => void handleRename()}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            {/* Non-destructive: tears down the live session, keeps the record.
                R7/F2: the destructive styling belongs to Delete below. */}
            <DropdownMenuItem onClick={handleLeave}>
              <XIcon />
              Leave
            </DropdownMenuItem>
            {/* R7/F2: "Delete conversation" is the truthful label — this
                deletes the record itself, not just messages — and only OPENS
                the confirmation dialog; clearConversation runs on confirm. */}
            <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
              <TrashIcon />
              Delete conversation
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DeleteConversationDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        conversationId={session.id}
        label={label}
      />
    </div>
  );
}

export interface DeleteConversationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Conversation the confirm will delete (controller.clearConversation). */
  readonly conversationId: ConversationId;
  /** Row label, surfaced in the description so the target is unambiguous. */
  readonly label: string;
}

/**
 * R7/F2: confirmation dialog for the sidebar's destructive delete, reusing
 * {@link WipeDataAlertDialog}'s pattern (controlled AlertDialog + toast on
 * settle). `controller.clearConversation` deletes the conversation RECORD —
 * messages, record, AND the identity binding that lets this browser resume
 * it (in-memory-repo.ts / browser-db-repo.ts); no "clear messages but keep
 * the conversation" operation exists in the store. The action is therefore
 * labeled "Delete conversation", confirmed before running, and the toast
 * states what actually happened. A live session for a deleted record stays
 * alive (`detached`) — R7F3 keeps it listed so it can still be left.
 */
export function DeleteConversationDialog({
  open,
  onOpenChange,
  conversationId,
  label,
}: DeleteConversationDialogProps): React.ReactElement {
  const { controller } = useChat();

  async function handleConfirm(): Promise<void> {
    if (controller === null) return;
    try {
      await controller.clearConversation(conversationId);
      toast.success("Conversation deleted");
    } catch (err: unknown) {
      toast.error("Could not delete", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Close on both settle paths: AlertDialogAction is a plain action
      // button, not an auto-closing primitive.
      onOpenChange(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
          <AlertDialogDescription>
            {label} will be deleted from this browser, including its message history, its
            conversation record, and the identity binding that lets this browser resume it. If it is
            currently connected, the live session stays open until you leave it. The server has no
            copy. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void handleConfirm()}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Row timestamp. Uses the last-message time when present; for a fresh
 * conversation with no messages, falls back to a short "New" pill so the row
 * never reads as missing information (the QC flagged a blank timestamp on the
 * active item). When a timestamp is available it is rendered as a `<time>`
 * with a machine-readable dateTime.
 */
function Timestamp({
  timestamp,
  connected,
}: {
  readonly timestamp: number | null;
  readonly connected: boolean;
}): React.ReactElement {
  if (timestamp === null) {
    return (
      <span
        className={cn(
          "shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4",
          connected ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        New
      </span>
    );
  }
  return (
    <time
      dateTime={new Date(timestamp).toISOString()}
      className="text-muted-foreground shrink-0 tabular-nums"
    >
      {formatRelative(timestamp)}
    </time>
  );
}

/**
 * Connection-state dot. Only the Connected state lights up (gold); every
 * other state reads as a muted hollow marker. This keeps the gold accent
 * rationed to "live" connections, matching the design rule (one accent,
 * used sparingly, only where it carries semantic state).
 */
function ConnectionDot({ connected }: { readonly connected: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        connected ? "bg-primary" : "bg-sidebar-foreground/30",
      )}
    />
  );
}

function placeholderForState(state: ConnectionState): string {
  if (state === ConnectionState.Connected) return "No messages yet";
  return CONNECTION_STATE_LABELS[state];
}

/**
 * Compact relative timestamp for the sidebar. Today -> HH:MM, this year ->
 * month + day, older -> year. Pure; SSR-safe (uses local time, no window
 * access).
 */
export function formatRelative(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Build the sidebar's unified list as a UNION of the persisted conversation
 * records and the live session summaries — the same merge the controller's
 * `buildState` exposes (live summary wins where both exist for an id).
 *
 * R7/F3: the list must NOT be derived from `state.conversations` alone.
 * `controller.clearConversation` deletes the record but keeps a live session
 * alive (`detached`, no teardown — chat-controller.ts), so a record-only list
 * made such a session vanish from the sidebar while it still held its
 * signaling socket and peer connection. Every live session therefore gets a
 * row even when no record exists for it; an active-but-unlisted conversation
 * cannot occur.
 *
 * Pure and non-mutating; sorted with {@link sortSessions}.
 */
export function buildUnifiedSessions(
  conversations: readonly ConversationRecord[],
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  const liveByKey = new Map<string, SessionSummary>();
  for (const s of sessions) liveByKey.set(sessionKey(s.id), s);
  const unified: SessionSummary[] = [];
  const listed = new Set<string>();
  for (const c of conversations) {
    const key = sessionKey(c.id);
    listed.add(key);
    const live = liveByKey.get(key);
    if (live !== undefined) {
      unified.push(live);
      continue;
    }
    // Persisted-only (no live session): default to Idle, no unread, no
    // preview. Sort by createdAt so stale chats don't all sink identically.
    // SEC-4: no live orchestrator means no negotiated auth mode; the safety-
    // number baseline matches the pre-PAKE fallback every persisted session
    // would otherwise display.
    unified.push({
      id: c.id,
      label: deriveSessionLabel(c, null),
      connectionState: ConnectionState.Idle,
      unread: 0,
      lastMessagePreview: null,
      lastMessageAt: c.createdAt,
      safetyNumberVerified: false,
      authFailed: c.authFailed,
      authMode: AuthMode.SafetyNumberOnly,
    });
  }
  // R7/F3: live sessions whose record was deleted (Delete conversation on a
  // live session) still list — the session is alive and selectable, so hiding
  // it would orphan a connected session behind an invisible row.
  for (const s of sessions) {
    if (!listed.has(sessionKey(s.id))) unified.push(s);
  }
  return sortSessions(unified);
}

/** Stable React key derived from the conversation id. */
function sessionKey(id: ConversationId): string {
  // ConversationId is a Uint8Array; convert to a hex string for React keys.
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, "0");
  }
  return hex;
}
