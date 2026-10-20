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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@fuck-eu-chat-control/ui/components/sheet";
import { cn } from "@fuck-eu-chat-control/ui/lib/utils";
import { PencilIcon, UserMinusIcon, UsersIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { MAX_MEMBER_DISPLAY_NAME } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type {
  ActiveGroupState,
  GroupMemberView,
} from "@fuck-eu-chat-control/chat-runtime/runtime/types";
import { useChat } from "@/features/chat/runtime/chat-provider";
import {
  clampUtf8Bytes,
  memberDisplayLabel,
  memberLinkLabel,
  memberLinkTone,
  shortKeyLabel,
  sortGroupMembers,
} from "@/features/chat/ui/group-members";
import { TESTIDS } from "@/features/chat/ui/testids";

/**
 * Phase 7b (protocol-v2): the group member panel — a right-side Sheet opened
 * from the group header's members button, self-contained like
 * {@link SettingsSheetTrigger} (the trigger owns the open state).
 *
 * Each row carries the member's link status dot, their announced display
 * name (or identity-key prefix when unnamed), an "author" badge on the list
 * signer, and a "(you)" marker on the local device. Sort order comes from
 * {@link sortGroupMembers}: author first, then display name.
 *
 * Actions are role-scoped, matching the runtime contract:
 *   - the local member's row offers a name edit (`setGroupDisplayName` —
 *     re-announced on every connected link, §4.1);
 *   - the author sees a remove affordance on every OTHER row, gated behind
 *     a confirm dialog before `removeGroupMember` (the membership change
 *     bumps the epoch, so the group safety number changes — the description
 *     says so). Non-authors get a read-only list.
 */
export function GroupMembersPanel({
  group,
}: {
  readonly group: ActiveGroupState;
}): React.ReactElement {
  const { controller } = useChat();
  const [open, setOpen] = React.useState(false);
  // Confirm-then-remove (same discipline as DeleteConversationDialog): the
  // row action only arms the dialog; removeGroupMember runs on confirm.
  const [pendingRemoval, setPendingRemoval] = React.useState<GroupMemberView | null>(null);
  const members = React.useMemo(() => sortGroupMembers(group.members), [group.members]);

  function handleSetName(): void {
    if (controller === null) return;
    const self = members.find((m) => m.isSelf);
    // prompt() is browser-only; this handler runs from a click, so the SSR
    // contract is not violated (same convention as the sidebar rename).
    const next = window.prompt("Your name in this group", self?.displayName ?? "");
    if (next === null) return;
    const name = clampUtf8Bytes(next.trim(), MAX_MEMBER_DISPLAY_NAME);
    try {
      controller.setGroupDisplayName(group.groupId, name);
    } catch (err: unknown) {
      toast.error("Could not set name", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleConfirmRemove(): Promise<void> {
    const member = pendingRemoval;
    if (controller === null || member === null) return;
    try {
      await controller.removeGroupMember(group.groupId, member.identityPub);
      toast.success("Member removed", {
        description:
          "The member list changed — the group safety number changed too, re-verify it if you rely on it.",
      });
    } catch (err: unknown) {
      toast.error("Could not remove member", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Close on both settle paths: AlertDialogAction is a plain action
      // button, not an auto-closing primitive.
      setPendingRemoval(null);
    }
  }

  const pendingLabel = pendingRemoval === null ? "" : memberDisplayLabel(pendingRemoval);

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label="Show members"
              data-testid={TESTIDS.groupMembers}
            />
          }
        >
          <UsersIcon />
          <span className="text-xs">{group.members.length}</span>
        </SheetTrigger>
        <SheetContent
          side="right"
          className="w-full sm:max-w-sm"
          data-testid={TESTIDS.groupMembersPanel}
        >
          <SheetHeader>
            <SheetTitle>
              {group.members.length} member{group.members.length === 1 ? "" : "s"}
            </SheetTitle>
            <SheetDescription>
              Everyone in the group connects directly to everyone else — the server only relays the
              handshakes, never the messages.
            </SheetDescription>
          </SheetHeader>
          <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-4 pb-4">
            {members.map((member) => (
              <MemberRow
                key={member.identityPubHex}
                member={member}
                canRemove={group.isAuthor && !member.isSelf}
                onRemove={() => setPendingRemoval(member)}
                onSetName={handleSetName}
              />
            ))}
          </ul>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(next: boolean) => {
          if (!next) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              They are dropped from the signed member list and their links close — they see that
              they were removed. The member list changes, so the group safety number changes too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void handleConfirmRemove()}
              data-testid={TESTIDS.groupMemberRemoveConfirm}
            >
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface MemberRowProps {
  readonly member: GroupMemberView;
  /** Author && not self — the runtime rejects self-removal anyway. */
  readonly canRemove: boolean;
  readonly onRemove: () => void;
  /** Opens the self display-name edit (rendered on the local member only). */
  readonly onSetName: () => void;
}

function MemberRow({ member, canRemove, onRemove, onSetName }: MemberRowProps): React.ReactElement {
  const label = memberDisplayLabel(member);
  const tone = memberLinkTone(member.linkState);
  return (
    <li
      className="flex items-center gap-2 rounded-md px-2 py-2"
      data-testid={TESTIDS.groupMemberRow}
      data-member-key={member.identityPubHex}
    >
      {/* Same dot language as the sidebar rows: lit primary when the pairwise
          link is up, dimmed primary while the link is still being built,
          muted when down/absent. */}
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-1.5 shrink-0 rounded-full",
          tone === "connected" && "bg-primary",
          tone === "connecting" && "bg-primary/40",
          tone === "disconnected" && "bg-muted-foreground/40",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{label}</span>
          {member.isSelf && <span className="text-muted-foreground text-xs">(you)</span>}
          {member.isAuthor && (
            <span className="bg-primary/10 text-primary inline-flex items-center rounded-full px-1.5 text-[10px] font-medium uppercase leading-4 tracking-wide">
              author
            </span>
          )}
        </span>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span>{member.isSelf ? "This device" : memberLinkLabel(member.linkState)}</span>
          {member.displayName.length > 0 && (
            <span className="font-mono">{shortKeyLabel(member.identityPubHex)}</span>
          )}
        </span>
      </span>
      {member.isSelf ? (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onSetName}
          aria-label="Set your name in this group"
          className="text-muted-foreground"
        >
          <PencilIcon />
        </Button>
      ) : (
        canRemove && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onRemove}
            aria-label={`Remove ${label}`}
            data-testid={TESTIDS.groupMemberRemove}
            className="text-muted-foreground hover:text-destructive"
          >
            <UserMinusIcon />
          </Button>
        )
      )}
    </li>
  );
}
