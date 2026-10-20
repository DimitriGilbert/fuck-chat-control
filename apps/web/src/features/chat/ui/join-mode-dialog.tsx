import { Button } from "@fuck-eu-chat-control/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fuck-eu-chat-control/ui/components/dialog";
import { MessageCircleIcon, UsersIcon } from "lucide-react";
import * as React from "react";

import { TESTIDS } from "@/features/chat/ui/testids";
import type { PendingInvitationJoin } from "@/features/chat/ui/use-invitation-join";

/**
 * The join-mode decision point (protocol-v2 §8). An invitation link's
 * fragment bytes are IDENTICAL for a 1:1 conversation and a group —
 * `#<hex>(~<code>)?` carries no mode bit — so when a link lands, the user
 * picks which join flow to run. Choosing wrong is honest, not catastrophic:
 * "Join as conversation" against a live group room is rejected by the
 * broker's room-mode check, and "Join as group" against a 1:1 room simply
 * seats the user in an otherwise-empty group room (the inviter's pair room
 * is a different mode), which the user can leave.
 *
 * Presentational: all join semantics live in {@link useInvitationJoin}; this
 * component only renders the choice and forwards the callbacks.
 */
export function JoinModeDialog({
  pending,
}: {
  readonly pending: PendingInvitationJoin;
}): React.ReactElement {
  const coded = pending.fragment.includes("~");
  return (
    <Dialog
      open
      onOpenChange={(next: boolean): void => {
        // No mid-flight dismissal (same discipline as the export dialog):
        // closing while joinConversation/joinGroup is in flight would orphan
        // the pending state. Esc/overlay dismissal stays available when idle.
        if (!next && pending.joining) return;
        if (!next) pending.dismiss();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>You were sent an invitation link</DialogTitle>
          <DialogDescription>
            The link does not say whether it opens a one-to-one conversation or a group — pick how
            to join.
            {coded && (
              <>
                {" "}
                This link also carries the required 6-digit code, so you will not be asked for it.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-start">
          <Button
            onClick={pending.joinAsPair}
            disabled={pending.joining}
            data-testid={TESTIDS.joinAsPair}
          >
            <MessageCircleIcon />
            Join as 1:1 conversation
          </Button>
          <Button
            variant="outline"
            onClick={pending.joinAsGroup}
            disabled={pending.joining}
            data-testid={TESTIDS.joinAsGroup}
          >
            <UsersIcon />
            Join as group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
