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
import { Input } from "@fuck-eu-chat-control/ui/components/input";
import { Label } from "@fuck-eu-chat-control/ui/components/label";
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
import { CopyIcon, PaperclipIcon, SendIcon, ShieldIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { AuthMode } from "@/features/chat/protocol/types";
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

  /**
   * R7/F3 (Phase 3b / CR-3): once the session has durably failed auth, retry
   * is disabled (re-handshaking with the same identity would just re-trigger
   * the same failure). The only recovery path is to start a fresh, uncoded
   * conversation. The orchestrator's `start()` allocates a new conversation
   * id and the InvitationBanner takes over to surface the new link.
   */
  async function handleCreateFreshInvitation(): Promise<void> {
    if (controller === null) return;
    try {
      await controller.startConversation();
    } catch (err: unknown) {
      toast.error("Could not create invitation", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
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
  // SEC-4: once connected, label the session's auth provenance. PAKE sessions
  // surface the stronger guarantee; safety-number sessions read as such so the
  // user can tell which conversations are only verified post-hoc.
  const connected = connectionState === ConnectionState.Connected;
  const authLabel =
    connected && authMode === AuthMode.Pake ? "PAKE" : "Safety number";
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <StatusPill variant={variant} label={label} />
      <span
        data-slot="auth-mode-pill"
        data-auth-mode={authMode === AuthMode.Pake ? "pake" : "safety-number"}
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium",
          authMode === AuthMode.Pake
            ? "bg-primary/10 text-primary"
            : "bg-secondary text-secondary-foreground",
        )}
      >
        <ShieldIcon
          className="size-3"
          aria-label={authMode === AuthMode.Pake ? "PAKE-authenticated" : "Safety number only"}
        />
        {authLabel}
      </span>
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
 *
 * Phase 10 — PAKE affordance: a "Protect with PAKE" control lets the inviter
 * attach a 6-digit code to the invitation. Selecting it tears down the current
 * (uncoded) conversation and starts a fresh one with a CSPRNG-generated code;
 * the new invitation link carries `~<code>` in the hash so the responder's
 * `parseInvitation` runs SPAKE2 against it. The code is also shown on its own
 * line with explicit "share out-of-band" copy: an attacker who intercepts the
 * link gets the code too, so for full MITM protection the code should travel
 * a different channel than the link.
 */
function InvitationBanner(): React.ReactElement | null {
  const { state, controller } = useChat();
  // Local input lets the inviter type a custom code (6 digits). Empty means
  // we will generate a fresh CSPRNG code on toggle. Held in component state so
  // the typing experience stays responsive independent of the controller's
  // snapshot cadence.
  const [pakeEnabled, setPakeEnabled] = React.useState(false);
  const [codeDraft, setCodeDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const invitation = state.invitation;
  // Pull the active code out of the invitation BEFORE any early return so the
  // useEffect below always sees the right value (no conditional hooks).
  const hashIndex = invitation?.lastIndexOf("#") ?? -1;
  const bare = hashIndex >= 0 ? (invitation as string).slice(hashIndex + 1) : (invitation ?? "");
  const tildeIdx = bare.indexOf("~");
  const activeCode = tildeIdx >= 0 ? bare.slice(tildeIdx + 1) : null;

  // Sync the local toggle to whatever the active invitation is shaped like.
  // This keeps the banner honest if the conversation is replaced externally.
  React.useEffect(() => {
    setPakeEnabled(activeCode !== null);
    if (activeCode !== null) setCodeDraft(activeCode);
  }, [activeCode]);

  if (invitation === null) return null;
  // Hide once the peer is connected or the session has dropped.
  if (
    state.connectionState === ConnectionState.Connected ||
    state.connectionState === ConnectionState.Disconnected
  ) {
    return null;
  }
  // After the null/hidden guards above, `invitation` is non-null and the
  // session is still waiting/handshaking. Bind a narrowed alias so the
  // closure handlers below get a `string` type.
  const activeInvitation: string = invitation;

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(activeInvitation);
      toast.success("Invitation link copied");
    } catch {
      toast.error("Clipboard unavailable", {
        description: "Copy the link from the address bar or select it manually.",
      });
    }
  }

  async function copyCode(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("PAKE code copied");
    } catch {
      // Non-fatal: the code is short enough to type by hand.
    }
  }

  /**
   * Apply the user's PAKE choice: leave the current uncoded conversation and
   * start a fresh one with the chosen code. The orchestrator's `start()`
   * requires the code up front (PAKE state must be ready before the peer
   * arrives), so we cannot mutate the existing invitation in place.
   *
   * Removing PAKE reverses the flow: leave the coded conversation and start
   * a fresh uncoded one.
   *
   * Phase 3b (CR-4): the 6-digit code is generated by the controller's
   * `generatePakeCode()` so the CSPRNG sampling + modular reduction live in
   * the security-relevant runtime, not the render layer.
   */
  async function applyPakeChoice(next: boolean): Promise<void> {
    if (controller === null || busy) return;
    setBusy(true);
    try {
      const currentId = state.activeConversationId;
      if (currentId !== null) {
        controller.leaveConversation(currentId);
      }
      if (next) {
        const code = codeDraft.trim().length === 6 ? codeDraft.trim() : controller.generatePakeCode();
        setCodeDraft(code);
        await controller.startConversation({ code });
        toast.success("PAKE-protected invitation ready", {
          description: "Share the code with your peer out-of-band.",
        });
      } else {
        await controller.startConversation();
        toast.success("Invitation ready");
      }
    } catch (err: unknown) {
      toast.error("Could not update invitation", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  function handleTogglePake(): void {
    const next = !pakeEnabled;
    setPakeEnabled(next);
    void applyPakeChoice(next);
  }

  function handleRegeneratePakeCode(): void {
    if (busy || controller === null) return;
    const fresh = controller.generatePakeCode();
    setCodeDraft(fresh);
    // Apply immediately so the invitation reflects the new code.
    void applyPakeChoice(true);
  }

  function handleCodeDraftChange(e: React.ChangeEvent<HTMLInputElement>): void {
    // Accept only digits, cap at 6.
    const cleaned = e.target.value.replace(/\D/g, "").slice(0, 6);
    setCodeDraft(cleaned);
  }

  function handleApplyCustomCode(): void {
    if (busy) return;
    if (codeDraft.length !== 6) {
      toast.error("Code must be 6 digits");
      return;
    }
    void applyPakeChoice(true);
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
          value={activeInvitation}
          onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-none border border-input bg-background px-2 py-1 font-mono text-xs"
          aria-label="Invitation link"
        />
        <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
          <CopyIcon className="size-4" />
          Copy link
        </Button>
      </div>

      <PakeControl
        enabled={pakeEnabled}
        activeCode={activeCode}
        codeDraft={codeDraft}
        busy={busy}
        onToggle={handleTogglePake}
        onRegenerate={handleRegeneratePakeCode}
        onCodeDraftChange={handleCodeDraftChange}
        onApplyCustomCode={handleApplyCustomCode}
        onCopyCode={copyCode}
      />
    </div>
  );
}

interface PakeControlProps {
  readonly enabled: boolean;
  readonly activeCode: string | null;
  readonly codeDraft: string;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onRegenerate: () => void;
  readonly onCodeDraftChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  readonly onApplyCustomCode: () => void;
  readonly onCopyCode: (code: string) => void;
}

/**
 * The PAKE-protection affordance. Renders as a single inline strip below the
 * invitation input, matching the existing borderless quiet-UI register: a
 * checkbox + label, and a collapsible detail row that exposes the code,
 * regenerate / custom-apply actions, and the out-of-band sharing note.
 *
 * Visual language follows the Lantern design system: the saffron-gold accent
 * (bg-primary/text-primary) is reserved for the protected state's badge and
 * the checkbox's checked fill. No teal/red-brown/green.
 */
function PakeControl(props: PakeControlProps): React.ReactElement {
  const {
    enabled,
    activeCode,
    codeDraft,
    busy,
    onToggle,
    onRegenerate,
    onCodeDraftChange,
    onApplyCustomCode,
    onCopyCode,
  } = props;

  // The 6-digit code currently carrying PAKE protection (displayed verbatim
  // so the user can read/type it to their peer).
  const displayCode = enabled ? (activeCode ?? codeDraft) : "";

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={enabled}
          onChange={onToggle}
          disabled={busy}
          aria-label="Protect this conversation with a 6-digit PAKE code"
          className="mt-0.5 size-3.5 accent-primary disabled:opacity-50"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-foreground inline-flex items-center gap-1 font-medium">
            <ShieldIcon className="text-primary size-3.5" aria-hidden="true" />
            Protect with a 6-digit code (PAKE)
          </span>
          <span className="text-muted-foreground leading-4">
            Authenticates the handshake against a malicious broker. An attacker who intercepts the
            link also gets the code — share it out-of-band for full protection.
          </span>
        </span>
      </label>

      {enabled && (
        <div
          className="bg-primary/5 border-primary/30 rounded-none border px-2 py-1.5"
          data-slot="pake-code"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
              PAKE code
            </span>
            {displayCode.length === 6 ? (
              <code
                className="text-primary text-sm font-semibold tabular-nums"
                aria-label="PAKE code"
              >
                {displayCode}
              </code>
            ) : (
              <span className="text-muted-foreground text-xs tabular-nums">generating…</span>
            )}
            {displayCode.length === 6 && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onCopyCode(displayCode)}
                disabled={busy}
                aria-label="Copy PAKE code"
              >
                <CopyIcon className="size-3" />
                Copy code
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={onRegenerate}
              disabled={busy}
              className="ml-auto"
              aria-label="Regenerate PAKE code"
            >
              Regenerate
            </Button>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Label
              htmlFor="pake-code-input"
              className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide"
            >
              Custom code
            </Label>
            <Input
              id="pake-code-input"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={codeDraft}
              onChange={onCodeDraftChange}
              disabled={busy}
              placeholder="6 digits"
              className="h-6 w-24 font-mono text-xs tabular-nums"
              aria-label="Custom PAKE code"
            />
            <Button
              variant="outline"
              size="xs"
              onClick={onApplyCustomCode}
              disabled={busy || codeDraft.length !== 6}
            >
              Apply
            </Button>
          </div>
        </div>
      )}
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
