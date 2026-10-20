import { Button } from "@fuck-eu-chat-control/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@fuck-eu-chat-control/ui/components/dialog";
import { ShieldCheckIcon, ShieldIcon } from "lucide-react";
import * as React from "react";

import type { GroupId } from "@fuck-eu-chat-control/chat-runtime/group/types";
import { useChat } from "@/features/chat/runtime/chat-provider";
import { TESTIDS } from "@/features/chat/ui/testids";

interface GroupSafetyDialogProps {
  readonly groupId: GroupId;
  /** The epoch-bound number — the same value `getGroupSafetyNumber` returns. */
  readonly safetyNumber: string;
  /** The member-list epoch the number covers; surfaced so re-checks after a
   *  membership change are anchored ("the number moved — did the list?"). */
  readonly epoch: number;
  readonly verified: boolean;
}

/**
 * The group analogue of {@link SafetyNumberDialog} (protocol-v2 §5): one
 * safety number covering the WHOLE member list at the current epoch,
 * computed identically on every member's client. The copy stays parallel to
 * the 1:1 dialog — compare out of band; matching numbers on every member's
 * screen mean nobody is relaying — with the group-specific property stated
 * up front: the number binds the member list, so a join or a removal
 * produces a new number that needs re-checking.
 *
 * The badge reads "Verify this group" until the user confirms; confirming
 * marks the CURRENT epoch verified (`markGroupSafetyVerified`) and a later
 * membership change resets the flag.
 */
export function GroupSafetyDialog({
  groupId,
  safetyNumber,
  epoch,
  verified,
}: GroupSafetyDialogProps): React.ReactElement {
  const { controller } = useChat();
  const [open, setOpen] = React.useState(false);

  function handleConfirm(): void {
    if (controller === null) return;
    controller.markGroupSafetyVerified(groupId);
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant={verified ? "outline" : "secondary"}
            size="sm"
            aria-label={verified ? "Group verified" : "Verify this group"}
            data-testid={TESTIDS.verifyGroup}
          />
        }
      >
        {verified ? <ShieldCheckIcon className="size-3" /> : <ShieldIcon className="size-3" />}
        <span className="text-xs">{verified ? "Verified" : "Verify this group"}</span>
      </DialogTrigger>
      <DialogContent data-testid={TESTIDS.groupSafetyDialog}>
        <DialogHeader>
          <DialogTitle>Verify this group</DialogTitle>
          <DialogDescription>
            Check this safety number with the whole group over a channel you all trust — in person,
            on a call, anywhere except this chat. If it matches on every member's screen, everyone
            sees the same member list and no one is sitting between you.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <pre
            className="break-all rounded-md bg-muted p-3 text-center font-mono text-xs leading-6"
            aria-label="Group safety number"
          >
            {safetyNumber}
          </pre>
          <p className="text-muted-foreground text-xs leading-5">
            This number covers the member list at epoch {epoch} — it changes whenever someone joins
            or is removed, so re-check it then.{" "}
            {verified ? "You marked this epoch as verified." : "Unverified until you confirm it."}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={verified}
            data-testid={TESTIDS.groupSafetyConfirm}
          >
            {verified ? "Already verified" : "The numbers match"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
