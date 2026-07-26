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
import { CopyIcon, SendIcon } from "lucide-react";
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
import { SafetyNumberDialog } from "@/features/chat/ui/safety-number-dialog";

/**
 * The active conversation view. Rendered whenever the controller has a
 * conversation id. Composes the transcript, composer, status bar, and the
 * safety-number dialog.
 */
export function ChatView(): React.ReactElement {
  const { controller, state } = useChat();
  const transcriptRef = React.useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = React.useState("");

  // Auto-scroll to the newest message when the transcript grows.
  React.useEffect(() => {
    const node = transcriptRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [state.messages]);

  const buckets = React.useMemo(() => bucketByDay(state.messages), [state.messages]);

  const canSend =
    controller !== null &&
    state.connectionState === ConnectionState.Connected &&
    draft.trim().length > 0;

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

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
      <StatusBar
        connectionState={state.connectionState}
        safetyNumber={state.safetyNumber}
        safetyNumberVerified={state.safetyNumberVerified}
        error={state.error}
        onRetry={handleRetry}
        onLeave={handleLeave}
      />

      <InvitationBanner />

      <div className="min-h-0 flex-1 overflow-hidden">
        {state.messages.length === 0 ? (
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
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          </MessageScrollerProvider>
        )}
      </div>

      <div className="border-t border-border p-2">
        <InputGroup>
          <InputGroupTextarea
            value={draft}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              state.connectionState === ConnectionState.Connected
                ? "Write a message…  (Enter to send, Shift+Enter for newline)"
                : "Waiting to connect…"
            }
            disabled={state.connectionState !== ConnectionState.Connected}
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
                      variant={
                        state.connectionState === ConnectionState.Connected ? "default" : "ghost"
                      }
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
