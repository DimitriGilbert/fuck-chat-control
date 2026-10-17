import { Button } from "@fuck-eu-chat-control/ui/components/button";
import { Bubble, BubbleContent } from "@fuck-eu-chat-control/ui/components/bubble";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@fuck-eu-chat-control/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@fuck-eu-chat-control/ui/components/input-group";
import { Marker, MarkerContent } from "@fuck-eu-chat-control/ui/components/marker";
import { Message, MessageContent } from "@fuck-eu-chat-control/ui/components/message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@fuck-eu-chat-control/ui/components/message-scroller";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@fuck-eu-chat-control/ui/components/tooltip";
import { cn } from "@fuck-eu-chat-control/ui/lib/utils";
import { PaperclipIcon, SendIcon, ShieldIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { AuthMode } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { MessageDirection } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ConversationMessage } from "@fuck-eu-chat-control/chat-runtime/store";
import type { TransferState } from "@fuck-eu-chat-control/chat-runtime/runtime/transfer-state";
import type { ChatController } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import {
  CONNECTION_STATE_LABELS,
  CONNECTION_STATE_VARIANTS,
  bucketByDay,
  formatTime,
} from "@/features/chat/ui/chat-status";
import type { ConnectionStateVariant } from "@/features/chat/ui/chat-status";
import { authModeDataValue, authModeGlyphLabel, authModeLabel } from "@/features/chat/ui/auth-mode";
import { shouldRestoreDraft } from "@/features/chat/ui/draft-restore";
import { FileTransferCard } from "@/features/chat/ui/file-transfer-card";
import { InvitationBanner } from "@/features/chat/ui/invitation-banner";
import { SafetyNumberDialog } from "@/features/chat/ui/safety-number-dialog";
import { TESTIDS } from "@/features/chat/ui/testids";

/**
 * The active conversation view. Rendered whenever the controller has a
 * conversation id. Composes the transcript, composer, status header, the
 * invitation panel (while waiting), and the verify affordance.
 */
export function ChatView(): React.ReactElement {
  const { controller, state } = useChat();
  const transcriptRef = React.useRef<HTMLDivElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = React.useState(false);

  const activeId = state.activeConversationId;
  const connected = state.connectionState === ConnectionState.Connected;
  // R10F2 (Phase 9): the composer draft lives on the SESSION (mirrored into
  // the snapshot as `active.draft`), not in component state. A component-level
  // draft survived conversation switches and sent to whichever session was
  // active at send time — text leaked across conversations. The fully
  // controlled textarea reads the stored value; every keystroke writes
  // through to `controller.setDraft`, so switching conversations restores
  // that conversation's own draft.
  const draft = state.active?.draft ?? "";

  // Auto-scroll to the newest message when the transcript grows.
  React.useEffect(() => {
    const node = transcriptRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [state.messages]);

  const buckets = React.useMemo(() => bucketByDay(state.messages), [state.messages]);

  const canSend = controller !== null && connected && draft.trim().length > 0;
  const canAttach = controller !== null && connected && activeId !== null;

  function handleSend(): void {
    if (controller === null || activeId === null) return;
    const text = draft;
    controller.setDraft(activeId, "");
    void controller.sendText(activeId, text).catch((err: unknown) => {
      // Restore into an EMPTY draft on the still-active conversation only
      // (see shouldRestoreDraft): the user may have typed more while the
      // send was in flight, or switched conversations.
      if (shouldRestoreDraft(controller.getState(), activeId)) {
        controller.setDraft(activeId, text);
      }
      toast.error("Send failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    event.preventDefault();
    if (canSend) handleSend();
  }

  function handleRetry(): void {
    if (controller === null) return;
    controller.retry();
  }

  function handleLeave(): void {
    if (controller === null) return;
    controller.leave();
  }

  /**
   * R7/F3 (Phase 3b / CR-3): once the session has durably failed auth, retry
   * is disabled (re-handshaking with the same identity would just re-trigger
   * the same failure). The only recovery path is to start a fresh, uncoded
   * conversation. The failed session is left FIRST (R7/F8, Phase 12):
   * startConversation only swaps the active id, so without the leave every
   * recovery click strands the dead session as a Disconnected list row.
   * The orchestrator's `start()` then allocates a new conversation id and the
   * InvitationBanner takes over to surface the new link.
   */
  async function handleCreateFreshInvitation(): Promise<void> {
    if (controller === null) return;
    try {
      const failedId = state.activeConversationId;
      if (failedId !== null) {
        controller.leaveConversation(failedId);
      }
      await controller.startConversation();
    } catch (err: unknown) {
      toast.error("Could not create invitation", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function sendFiles(files: FileList | readonly File[]): void {
    if (controller === null || activeId === null) return;
    // A.5: the controller's sendFile takes a neutral {data,name,mimeType}
    // payload (no DOM File). Read each File into bytes at the call site — the
    // runtime core never touches the DOM File type.
    for (const file of Array.from(files)) {
      void file.arrayBuffer().then((buffer): void => {
        if (controller === null || activeId === null) return;
        void controller
          .sendFile(activeId, {
            data: new Uint8Array(buffer),
            name: file.name,
            mimeType: file.type,
          })
          .catch((err: unknown) => {
            toast.error("File send failed", {
              description: err instanceof Error ? err.message : String(err),
            });
          });
      });
    }
  }

  function handleAttachClick(): void {
    fileInputRef.current?.click();
  }

  function handleFilePick(event: React.ChangeEvent<HTMLInputElement>): void {
    if (event.target.files === null) return;
    sendFiles(event.target.files);
    // Reset so picking the same file twice fires change again.
    event.target.value = "";
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsDragOver(false);
    if (!connected) return;
    if (event.dataTransfer.files.length === 0) return;
    sendFiles(event.dataTransfer.files);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>): void {
    // R10F3 (Phase 9): preventDefault unconditionally. Skipping it while
    // disconnected let the browser treat `drop` as a navigation (opening the
    // file), which tore down the page — live sessions and received
    // attachments included. Only the affordance highlight is gated on
    // connected.
    event.preventDefault();
    if (!connected) return;
    if (!isDragOver) setIsDragOver(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>): void {
    // Clear only when the pointer leaves the container entirely (the
    // relatedTarget is outside, or null when leaving the window).
    const next = event.relatedTarget;
    if (next === null || !event.currentTarget.contains(next as Node | null)) {
      setIsDragOver(false);
    }
  }

  const transfers = state.active?.transfers ?? [];

  return (
    <div
      data-drop-zone="chat"
      className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <StatusBar
        connectionState={state.connectionState}
        safetyNumber={state.safetyNumber}
        safetyNumberVerified={state.safetyNumberVerified}
        authMode={state.active?.authMode ?? AuthMode.SafetyNumberOnly}
        authFailed={state.active?.authFailed ?? false}
        error={state.error}
        onRetry={handleRetry}
        onCreateInvitation={handleCreateFreshInvitation}
        onLeave={handleLeave}
      />

      <InvitationBanner />

      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden",
          isDragOver && "ring-1 ring-inset ring-ring/40",
        )}
      >
        {state.messages.length === 0 && transfers.length === 0 ? (
          <NoMessages connectionState={state.connectionState} />
        ) : (
          <MessageScrollerProvider>
            <MessageScroller className="h-full">
              <MessageScrollerViewport ref={transcriptRef}>
                <MessageScrollerContent>
                  {buckets.map((bucket) => (
                    <React.Fragment key={bucket.key}>
                      <Marker variant="separator">
                        <MarkerContent>{bucket.label}</MarkerContent>
                      </Marker>
                      {bucket.messages.map((message) => (
                        <MessageScrollerItem key={message.id}>
                          <MessageRow message={message} />
                        </MessageScrollerItem>
                      ))}
                    </React.Fragment>
                  ))}
                  {transfers.length > 0 && (
                    <MessageScrollerItem>
                      <TransfersSection
                        transfers={transfers}
                        controller={controller}
                        activeId={activeId}
                      />
                    </MessageScrollerItem>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          </MessageScrollerProvider>
        )}
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="bg-background text-foreground border-border rounded-md border px-3 py-1.5 text-xs shadow-sm">
              Drop files to send end-to-end encrypted
            </span>
          </div>
        )}
      </div>

      <div className="border-t border-border p-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFilePick}
          aria-hidden="true"
          tabIndex={-1}
        />
        <InputGroup>
          <InputGroupAddon align="inline-start">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      size="icon-sm"
                      variant={connected ? "outline" : "ghost"}
                      onClick={handleAttachClick}
                      disabled={!canAttach}
                      aria-label="Attach files"
                    />
                  }
                >
                  <PaperclipIcon />
                </TooltipTrigger>
                <TooltipContent>Attach files</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </InputGroupAddon>
          <InputGroupTextarea
            value={draft}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
              // R10F2: write every keystroke through to the session's draft so
              // the text is scoped to THIS conversation and restored on
              // switch-back. The emit in setDraft publishes the echo for the
              // controlled textarea.
              if (controller !== null && activeId !== null) {
                controller.setDraft(activeId, e.target.value);
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              connected
                ? "Write a message…  (Enter to send, Shift+Enter for newline)"
                : "Waiting to connect…"
            }
            disabled={!connected}
            aria-label="Message"
            rows={1}
          />
          <InputGroupAddon align="inline-end">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      size="icon-sm"
                      variant={connected ? "default" : "ghost"}
                      onClick={handleSend}
                      disabled={!canSend}
                      aria-label="Send message"
                    />
                  }
                >
                  <SendIcon />
                </TooltipTrigger>
                <TooltipContent>Send (Enter)</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}

/**
 * Render the session's transfer list as a stack of attachment cards. Sent
 * transfers align to the trailing edge (matching sent bubbles); received
 * transfers align to the leading edge and carry the ephemeral-storage
 * warning.
 */
function TransfersSection(props: {
  readonly transfers: readonly TransferState[];
  readonly controller: ChatController | null;
  readonly activeId: ConversationId | null;
}): React.ReactElement {
  const { transfers, controller, activeId } = props;
  return (
    <Message align="start">
      <MessageContent>
        <div className="flex flex-col gap-1.5">
          {transfers.map((t) => {
            const receivedFile =
              controller !== null && activeId !== null
                ? controller.getReceivedFile(activeId, t.id)
                : null;
            return (
              <FileTransferCard
                key={t.id}
                name={t.name}
                mimeType={t.mimeType}
                size={t.size}
                bytesTransferred={t.bytesTransferred}
                status={t.status}
                direction={t.direction}
                error={t.error}
                file={receivedFile}
                onCancel={
                  controller !== null && activeId !== null
                    ? (): void => controller.cancelTransfer(activeId, t.id)
                    : undefined
                }
              />
            );
          })}
        </div>
      </MessageContent>
    </Message>
  );
}

interface StatusBarProps {
  readonly connectionState: ConnectionState;
  readonly safetyNumber: string | null;
  readonly safetyNumberVerified: boolean;
  readonly authMode: AuthMode;
  /**
   * R7/F3 (Phase 3b / CR-3): durable auth-failed flag. When true, the retry
   * affordance is hidden (re-handshaking would just re-fail) and a "Create a
   * fresh invitation" CTA is rendered in its place.
   */
  readonly authFailed: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  /**
   * Invoked when the user picks the "Create a fresh invitation" recovery CTA
   * (rendered when {@link authFailed} is true). The handler leaves the failed
   * session and starts a fresh uncoded conversation.
   */
  readonly onCreateInvitation: () => void;
  readonly onLeave: () => void;
}

function StatusBar(props: StatusBarProps): React.ReactElement {
  const {
    connectionState,
    safetyNumber,
    safetyNumberVerified,
    authMode,
    authFailed,
    error,
    onRetry,
    onCreateInvitation,
    onLeave,
  } = props;
  const variant = CONNECTION_STATE_VARIANTS[connectionState];
  const label = CONNECTION_STATE_LABELS[connectionState];
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5">
      <StatusPill variant={variant} label={label} />
      <AuthPill authMode={authMode} connectionState={connectionState} />
      {safetyNumber !== null && (
        <SafetyNumberDialog safetyNumber={safetyNumber} verified={safetyNumberVerified} />
      )}
      {error !== null && (
        <span className="text-destructive text-xs" title={error}>
          {error}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {/*
         * R7/F3 (Phase 3b / CR-3): retry is gated on Disconnected AND
         * !authFailed. When auth previously failed, re-handshaking with the
         * same identity is durably blocked; the only recovery is a fresh
         * invitation. The fresh-invitation CTA takes over the same slot so
         * the user has exactly one obvious action.
         */}
        {connectionState === ConnectionState.Disconnected && !authFailed && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
        {connectionState === ConnectionState.Disconnected && authFailed && (
          <Button variant="default" size="sm" onClick={onCreateInvitation}>
            Create a fresh invitation
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onLeave}>
          Leave
        </Button>
      </div>
    </div>
  );
}

interface StatusPillProps {
  readonly variant: ConnectionStateVariant;
  readonly label: string;
}

function StatusPill({ variant, label }: StatusPillProps): React.ReactElement {
  return (
    <span
      data-variant={variant}
      data-testid={TESTIDS.connectionState}
      className={cn(
        "bg-secondary text-secondary-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        variant === "destructive" && "bg-destructive/10 text-destructive",
        variant === "default" && "bg-primary/10 text-primary",
      )}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * The handshake-authentication pill. Plain words: "Extra code" when the
 * handshake was code-authenticated, "Link only" otherwise. Label, styling,
 * data-auth-mode, and glyph label all key on `authMode` alone (R10F5).
 */
function AuthPill({
  authMode,
  connectionState,
}: {
  readonly authMode: AuthMode;
  readonly connectionState: ConnectionState;
}): React.ReactElement {
  return (
    <span
      data-slot="auth-mode-pill"
      data-auth-mode={authModeDataValue(authMode)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        authMode === AuthMode.Pake
          ? "bg-primary/10 text-primary"
          : "bg-secondary text-secondary-foreground",
      )}
    >
      <ShieldIcon className="size-3" aria-label={authModeGlyphLabel(authMode)} />
      {authModeLabel(authMode, connectionState)}
    </span>
  );
}

function NoMessages({
  connectionState,
}: {
  readonly connectionState: ConnectionState;
}): React.ReactElement {
  const waiting = connectionState !== ConnectionState.Connected;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{waiting ? "Nothing here yet" : "No messages yet"}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <p className="text-muted-foreground text-sm">
          {waiting
            ? "The conversation starts when your peer opens the link. Everything that follows is end-to-end encrypted — the server never sees the content."
            : "Say hello. Everything you send is end-to-end encrypted — the server never sees the content."}
        </p>
      </EmptyContent>
    </Empty>
  );
}

function MessageRow({ message }: { readonly message: ConversationMessage }): React.ReactElement {
  const sent = message.direction === MessageDirection.Sent;
  return (
    <Message align={sent ? "end" : "start"}>
      <MessageContent>
        <Bubble variant={sent ? "default" : "outline"} align={sent ? "end" : "start"}>
          <BubbleContent>{message.text}</BubbleContent>
        </Bubble>
        <div className={sent ? "text-right" : "text-left"}>
          <span className="text-muted-foreground px-1 text-xs">
            {formatTime(message.timestamp)}
          </span>
        </div>
      </MessageContent>
    </Message>
  );
}
