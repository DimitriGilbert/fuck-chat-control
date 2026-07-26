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
import { CopyIcon, PaperclipIcon, SendIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { ConnectionState } from "@/features/chat/signaling/state-machine";
import { MessageDirection } from "@/features/chat/store";
import type { ConversationMessage } from "@/features/chat/store";
import {
  CONNECTION_STATE_LABELS,
  CONNECTION_STATE_VARIANTS,
  bucketByDay,
  formatTime,
} from "@/features/chat/ui/chat-status";
import type { ConnectionStateVariant } from "@/features/chat/ui/chat-status";
import { FileTransferCard } from "@/features/chat/ui/file-transfer-card";
import { SafetyNumberDialog } from "@/features/chat/ui/safety-number-dialog";

/**
 * The active conversation view. Rendered whenever the controller has a
 * conversation id. Composes the transcript, composer, status bar, and the
 * safety-number dialog.
 */
export function ChatView(): React.ReactElement {
  const { controller, state } = useChat();
  const transcriptRef = React.useRef<HTMLDivElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = React.useState("");
  const [isDragOver, setIsDragOver] = React.useState(false);

  const activeId = state.activeConversationId;
  const connected = state.connectionState === ConnectionState.Connected;

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
    if (controller === null) return;
    const text = draft;
    setDraft("");
    void controller.sendText(text).catch((err: unknown) => {
      setDraft(text);
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

  function sendFiles(files: FileList | readonly File[]): void {
    if (controller === null || activeId === null) return;
    for (const file of Array.from(files)) {
      void controller.sendFile(activeId, file).catch((err: unknown) => {
        toast.error("File send failed", {
          description: err instanceof Error ? err.message : String(err),
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
    if (!connected) return;
    event.preventDefault();
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
        error={state.error}
        onRetry={handleRetry}
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
          <NoMessages />
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
            <span className="bg-background text-foreground border-border rounded-none border px-3 py-1.5 text-xs">
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
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
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
  readonly transfers: readonly import("@/features/chat/runtime/transfer-state").TransferState[];
  readonly controller: import("@/features/chat/runtime/chat-controller").ChatController | null;
  readonly activeId: import("@/features/chat/protocol/types").ConversationId | null;
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
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onLeave: () => void;
}

function StatusBar(props: StatusBarProps): React.ReactElement {
  const { connectionState, safetyNumber, safetyNumberVerified, error, onRetry, onLeave } = props;
  const variant = CONNECTION_STATE_VARIANTS[connectionState];
  const label = CONNECTION_STATE_LABELS[connectionState];
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <StatusPill variant={variant} label={label} />
      {safetyNumber !== null && (
        <SafetyNumberDialog safetyNumber={safetyNumber} verified={safetyNumberVerified} />
      )}
      {error !== null && (
        <span className="text-destructive text-xs" title={error}>
          {error}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {connectionState === ConnectionState.Disconnected && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onLeave}>
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
      className="bg-secondary text-secondary-foreground inline-flex items-center gap-1 rounded-none px-2 py-0.5 text-xs font-medium"
    >
      <span className="size-1.5 rounded-none bg-current opacity-70" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * While the initiator waits for a peer, the route has already flipped to
 * ChatView (because `state.conversationId` is set as soon as the conversation
 * is created). Without this banner the inviter has no way to copy the link they
 * just generated. Shows the invitation link plus a Copy button until the peer
 * connects.
 */
function InvitationBanner(): React.ReactElement | null {
  const { state } = useChat();
  if (state.invitation === null) return null;
  // Hide once the peer is connected or the session has dropped.
  if (
    state.connectionState === ConnectionState.Connected ||
    state.connectionState === ConnectionState.Disconnected
  ) {
    return null;
  }

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(state.invitation as string);
      toast.success("Invitation link copied");
    } catch {
      toast.error("Clipboard unavailable", {
        description: "Copy the link from the address bar or select it manually.",
      });
    }
  }

  return (
    <div className="border-b border-border px-3 py-2">
      <p className="text-muted-foreground mb-1 text-xs">
        Share this link with your peer. The <code>#</code> fragment stays in their URL bar and is
        never sent to the server.
      </p>
      <div className="flex items-stretch gap-2">
        <input
          readOnly
          value={state.invitation}
          onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-none border border-input bg-background px-2 py-1 font-mono text-xs"
          aria-label="Invitation link"
        />
        <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
          <CopyIcon className="size-4" />
          Copy link
        </Button>
      </div>
    </div>
  );
}

function NoMessages(): React.ReactElement {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No messages yet</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <p className="text-muted-foreground text-sm">
          Once the peer connects, your messages will appear here end-to-end encrypted. The server
          never sees the content.
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
