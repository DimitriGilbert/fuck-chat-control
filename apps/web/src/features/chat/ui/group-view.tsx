import { Bubble, BubbleContent } from "@fuck-eu-chat-control/ui/components/bubble";
import { Button } from "@fuck-eu-chat-control/ui/components/button";
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
import { CopyIcon, LockIcon, SendIcon, UsersIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import type {
  GroupChatMessage,
  GroupMemberView,
} from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { MessageDirection } from "@fuck-eu-chat-control/chat-runtime/store";
import { useChat } from "@/features/chat/runtime/chat-provider";
import { bucketByDay, formatTime } from "@/features/chat/ui/chat-status";
import { shouldRestoreGroupDraft } from "@/features/chat/ui/draft-restore";
import { senderLabel } from "@/features/chat/ui/group-members";
import { GroupMembersPanel } from "@/features/chat/ui/group-members-panel";
import { GroupSafetyDialog } from "@/features/chat/ui/group-safety-dialog";
import { InvitationLinkField } from "@/features/chat/ui/invitation-banner";
import { TESTIDS } from "@/features/chat/ui/testids";

/**
 * Phase 7a (protocol-v2): the main-pane surface for the ACTIVE group. This
 * is the runtime-glue view — a working group chat, not the finished
 * experience: header with the `k/n connected` link summary and Leave, the
 * author's invitation panel (the link stays valid while the group is
 * seated, so it never hides), the shared transcript primitives (plain
 * bubbles + a sender-name caption on received messages), and the composer
 * wired to `sendGroupText` + `setGroupDraft` with the same Enter/draft
 * contract as the 1:1 composer.
 *
 * Phase 7b layered the polished surfaces on top: {@link GroupMembersPanel}
 * (member list + author admin controls), {@link GroupSafetyDialog} (the
 * epoch-bound group safety number), and the shared `senderLabel` fallback
 * for message attribution.
 */
export function GroupView(): React.ReactElement | null {
  const { controller, state } = useChat();
  const transcriptRef = React.useRef<HTMLDivElement | null>(null);
  const group = state.activeGroup;

  // Auto-scroll to the newest message when the transcript grows.
  const messages = group?.messages ?? [];
  React.useEffect(() => {
    const node = transcriptRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  const buckets = React.useMemo(() => bucketByDay(messages), [messages]);

  // `group` is read inside handlers below; the early return sits after all
  // hooks so the component never violates the rules of hooks.
  const draft = group?.draft ?? "";
  const members = group?.members ?? [];
  // Linkable peers exclude self (the local member holds no link to itself).
  const connectedCount = members.filter((m) => m.linkState === ConnectionState.Connected).length;
  const canSend = controller !== null && connectedCount > 0 && draft.trim().length > 0;

  function handleSend(): void {
    if (controller === null || group === null) return;
    const groupId = group.groupId;
    const text = draft;
    controller.setGroupDraft(groupId, "");
    void controller.sendGroupText(groupId, text).catch((err: unknown) => {
      // Mirror the 1:1 restore contract: write the failed text back only
      // into an EMPTY draft on the still-active group.
      if (shouldRestoreGroupDraft(controller.getState(), groupId)) {
        controller.setGroupDraft(groupId, text);
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

  function handleLeave(): void {
    if (controller === null) return;
    controller.leaveGroup();
  }

  if (group === null) return null;

  const label =
    group.displayName ??
    `Group · ${group.members.length} member${group.members.length === 1 ? "" : "s"}`;
  const others = Math.max(group.members.length - 1, 0);

  return (
    <div
      className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col"
      data-testid={TESTIDS.groupView}
    >
      {/* Header: group label + live k/n link summary + the epoch-bound
          safety affordance (same placement as the 1:1 verify badge), with
          the members sheet and Leave on the right. Zero connected links
          earns an honest "waiting for members" hint — never a success
          state. */}
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <UsersIcon className="text-primary size-4" aria-hidden="true" />
          {label}
        </span>
        <span
          className="bg-secondary text-secondary-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
          aria-label={`${connectedCount} of ${others} members connected`}
        >
          <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
          {others > 0 ? `${connectedCount}/${others} connected` : "Just you so far"}
        </span>
        {connectedCount === 0 && (
          <span className="text-muted-foreground text-xs">waiting for members</span>
        )}
        {/* Group link/session failures surface on the controller-level
            `state.error` (onGroupSessionError) — rendered inline like the
            1:1 status bar so a dead link is never silent. */}
        {state.error !== null && (
          <span className="text-destructive text-xs" title={state.error}>
            {state.error}
          </span>
        )}
        {group.safetyNumber !== null && (
          <GroupSafetyDialog
            groupId={group.groupId}
            safetyNumber={group.safetyNumber}
            epoch={group.epoch}
            verified={group.safetyNumberVerified}
          />
        )}
        <div className="ml-auto flex items-center gap-1">
          <GroupMembersPanel group={group} />
          <Button variant="ghost" size="sm" onClick={handleLeave}>
            Leave group
          </Button>
        </div>
      </div>

      {group.invitation !== null && <GroupInvitationPanel invitation={group.invitation} />}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {messages.length === 0 ? (
          <GroupNoMessages connectedCount={connectedCount} />
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
                          <GroupMessageRow message={message} members={members} />
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
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
              // R10F2, mirrored for groups: every keystroke writes through to
              // the GROUP's draft so the text is scoped to this group and
              // restored on switch-back.
              if (controller !== null && group !== null) {
                controller.setGroupDraft(group.groupId, e.target.value);
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              connectedCount > 0
                ? "Write to the group…  (Enter to send, Shift+Enter for newline)"
                : "Waiting for members to connect…"
            }
            disabled={connectedCount === 0}
            aria-label="Group message"
            rows={1}
          />
          <InputGroupAddon align="inline-end">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      size="icon-sm"
                      variant={connectedCount > 0 ? "default" : "ghost"}
                      onClick={handleSend}
                      disabled={!canSend}
                      aria-label="Send group message"
                    />
                  }
                >
                  <SendIcon />
                </TooltipTrigger>
                <TooltipContent>Send to the group (Enter)</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}

/**
 * The author's invitation panel. Unlike the 1:1 banner this does NOT hide
 * once a link connects — group members stay seated in the broker room
 * precisely so late joiners can still arrive, so the link remains shareable
 * for the group's whole life. Rendered only when `invitation` is non-null
 * (joiner sessions mint none).
 */
function GroupInvitationPanel({ invitation }: { readonly invitation: string }): React.ReactElement {
  // The `~code` tail, when present, is the 6-digit code every member needs —
  // rendered verbatim with the same out-of-band warning as the 1:1 banner.
  const hashIndex = invitation.lastIndexOf("#");
  const bare = hashIndex >= 0 ? invitation.slice(hashIndex + 1) : invitation;
  const tildeIdx = bare.indexOf("~");
  const code = tildeIdx >= 0 ? bare.slice(tildeIdx + 1) : null;

  async function copyCode(): Promise<void> {
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Code copied");
    } catch {
      // Non-fatal: the code is short enough to type by hand.
    }
  }

  return (
    <div className="border-b border-border px-3 py-3">
      <div className="border-border bg-card flex flex-col gap-3 rounded-lg border p-3">
        <div className="flex flex-col gap-1">
          <p className="text-foreground text-sm font-medium">
            Share this link with everyone you want in.
          </p>
          <p className="text-muted-foreground text-xs leading-5">
            New members can join while the group is seated — they must be online to join, and they
            connect directly to every member. The part after <code>#</code> never leaves their
            browser.
          </p>
        </div>
        <InvitationLinkField invitation={invitation} shareTitle="Join my private group" />
        {code !== null && (
          <div
            className="bg-primary/5 border-primary/30 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2.5"
            data-slot="extra-code"
          >
            <LockIcon className="text-primary size-3.5" aria-hidden="true" />
            <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
              Extra code
            </span>
            <code
              className="text-primary text-base font-semibold tracking-[0.3em] tabular-nums"
              aria-label="Group extra code"
              data-testid={TESTIDS.extraCodeValue}
            >
              {code}
            </code>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void copyCode()}
              aria-label="Copy extra code"
            >
              <CopyIcon className="size-3" />
              Copy code
            </Button>
            <span className="text-muted-foreground basis-full text-xs leading-4">
              Every member needs this code too — send it on a different channel than the link.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function GroupMessageRow({
  message,
  members,
}: {
  readonly message: GroupChatMessage;
  readonly members: readonly GroupMemberView[];
}): React.ReactElement {
  const sent = message.direction === MessageDirection.Sent;
  return (
    <Message align={sent ? "end" : "start"}>
      <MessageContent>
        {!sent && message.senderIdentityPub !== null && (
          <div className="text-left">
            <span className="text-muted-foreground px-1 text-xs font-medium">
              {senderLabel(message.senderIdentityPub, members)}
            </span>
          </div>
        )}
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

function GroupNoMessages({
  connectedCount,
}: {
  readonly connectedCount: number;
}): React.ReactElement {
  const waiting = connectedCount === 0;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{waiting ? "Nobody else is here yet" : "No messages yet"}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <p className="text-muted-foreground text-sm">
          {waiting
            ? "Members appear as they open the link and connect. Everything that follows is end-to-end encrypted — the server never sees the content."
            : "Say hello to the group. Everything you send is end-to-end encrypted — the server never sees the content."}
        </p>
      </EmptyContent>
    </Empty>
  );
}
