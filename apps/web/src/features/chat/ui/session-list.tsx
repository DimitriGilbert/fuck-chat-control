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
  Loader2Icon,
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
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { SessionSummary } from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { CONNECTION_STATE_LABELS } from "@/features/chat/ui/chat-status";
import { conversationIdKey } from "@/features/chat/ui/unified-sessions";

/**
 * Session list surface extracted from sidebar.tsx so the desktop rail and the
 * mobile list-first home share one implementation: the unified sessions union
 * is rendered as tappable rows (label, presence dot, preview, unread badge,
 * per-row actions) plus the "Start a conversation" CTA.
 *
 * Row taps resolve through {@link ConversationList}'s handleSelect, which
 * preserves the original semantics: a persisted-only row resumes via
 * `controller.resumeConversation`; a live row selects via
 * `controller.selectConversation`.
 */

export interface ConversationListProps {
  /** The unified (records ∪ live sessions) sorted list to render. */
  readonly sessions: readonly SessionSummary[];
  /**
   * Invoked after EVERY row tap (including re-taps of the already-active
   * row). The mobile shell uses it to reveal the pushed-over chat pane —
   * re-tapping the active row must re-open the chat even though the
   * controller-side select is a no-op.
   */
  readonly onSessionOpen?: () => void;
  /** data-testid anchor for the list container. */
  readonly testId?: string;
}

export function ConversationList({
  sessions,
  onSessionOpen,
  testId,
}: ConversationListProps): React.ReactElement {
  const { controller, state } = useChat();
  const activeId = state.activeConversationId;

  function handleSelect(id: ConversationId): void {
    // The mobile overlay re-opens on ANY row tap, even a no-op select of the
    // already-active conversation — the callback runs first so a swallowed
    // select cannot strand the user on the list.
    onSessionOpen?.();
    if (controller === null) return;
    if (id === activeId) return;
    // A row may be persisted-only (no live session). Selecting it must resume
    // rather than no-op, so left conversations are still openable from the list.
    const isLive = state.sessions.some((s) => conversationIdKey(s.id) === conversationIdKey(id));
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
    <ul data-testid={testId} className="flex flex-col gap-0.5">
      {sessions.map((session) => (
        <li key={conversationIdKey(session.id)}>
          <SessionRow
            session={session}
            active={conversationIdKey(session.id) === conversationIdKeyOrNull(activeId)}
            onSelect={() => handleSelect(session.id)}
          />
        </li>
      ))}
    </ul>
  );
}

/** Null-safe wrapper so an absent active id never compares equal. */
function conversationIdKeyOrNull(id: ConversationId | null): string {
  return id === null ? "" : conversationIdKey(id);
}

export interface StartConversationButtonProps {
  readonly className?: string;
  /** data-testid anchor — distinct per surface (sidebar / mobile / empty). */
  readonly testId: string;
}

/** Shared failure toast for startConversation, from click or queued intent. */
function reportStartError(err: unknown): void {
  toast.error("Could not start", {
    description: err instanceof Error ? err.message : String(err),
  });
}

/**
 * The primary CTA shared by the sidebar, the mobile home, and the empty
 * state. One implementation so the label, icon, ready-gating, and error
 * handling stay identical everywhere.
 */
export function StartConversationButton({
  className,
  testId,
}: StartConversationButtonProps): React.ReactElement {
  const { controller, ready, state } = useChat();
  const [queued, setQueued] = React.useState(false);
  // While `ready` is false the provider is still opening the OPFS worker,
  // wasm and identity — a few seconds on a slow device. The button stays
  // ENABLED: a click during boot queues the intent and fires the moment the
  // controller publishes, so the app feels responsive instead of dead. The
  // label still says what it's doing; if boot failed (`state.error` set,
  // `ready` never flips) say that instead of spinning forever.
  const booting = !ready && state.error === null;
  const bootError = !ready ? state.error : null;
  const busy = booting || queued;

  // Fire a queued start once the controller exists; drop it if boot failed
  // meanwhile (the inline error already explains why nothing happens).
  React.useEffect(() => {
    if (!queued) return;
    if (controller === null) {
      if (state.error !== null) setQueued(false);
      return;
    }
    void controller
      .startConversation()
      .catch(reportStartError)
      .finally(() => setQueued(false));
  }, [queued, controller, state.error]);

  function handleStart(): void {
    if (controller === null) {
      if (state.error === null) setQueued(true);
      return;
    }
    void controller.startConversation().catch(reportStartError);
  }

  return (
    <div className="flex w-full flex-col gap-1.5">
      <Button
        variant="default"
        size="sm"
        className={cn("w-full justify-start", className)}
        onClick={handleStart}
        disabled={bootError !== null}
        aria-busy={busy}
        data-testid={testId}
      >
        {busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
        {busy ? (ready ? "Starting…" : "Setting up secure storage…") : "Start a conversation"}
      </Button>
      {bootError !== null && (
        <p role="alert" className="text-destructive px-1 text-xs leading-5">
          Something failed to load — reload the page to try again. ({bootError})
        </p>
      )}
    </div>
  );
}

/**
 * Clickable row in the conversation list. Renders peer label, a
 * connection-state dot, last-message preview + relative timestamp, and an
 * unread badge when > 0. A trailing DropdownMenu exposes Rename / Leave /
 * Delete conversation.
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
  // SEC-4: sessions authenticated with the extra code carry a lock glyph so
  // users can tell which conversations are code-protected vs
  // safety-number-only at a glance.
  const codeProtected = session.authMode === AuthMode.Pake;

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
    // record (same semantics as the previous-conversations Leave).
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
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2.5 text-left focus-visible:bg-sidebar-accent/60 focus-visible:outline-none"
        aria-current={active ? "true" : undefined}
      >
        <span className="flex items-center gap-1.5">
          <ConnectionDot connected={connected} />
          <span className="truncate text-sm font-medium">{label}</span>
          {codeProtected && (
            <LockIcon
              className="text-sidebar-primary size-3.5 shrink-0"
              aria-label="Protected by an extra code"
            />
          )}
          {verified && (
            <CheckCheckIcon
              className="text-sidebar-primary size-3.5 shrink-0"
              aria-label="Peer verified"
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
 * R7/F2: confirmation dialog for the list's destructive delete, reusing
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
 * never reads as missing information. When a timestamp is available it is
 * rendered as a `<time>` with a machine-readable dateTime.
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
 * other state reads as a muted hollow marker. The dot is the sole presence
 * signal — keyed to connection state only, never to invented identity data.
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
 * Compact relative timestamp for the list. Today -> HH:MM, this year ->
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
