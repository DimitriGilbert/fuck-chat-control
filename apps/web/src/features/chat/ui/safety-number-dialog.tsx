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

import { useChat } from "@/features/chat/runtime/chat-provider";
import { TESTIDS } from "@/features/chat/ui/testids";

interface SafetyNumberDialogProps {
  readonly safetyNumber: string;
  readonly verified: boolean;
}

/**
 * The "Verify it's really them" affordance in the chat header: a compact
 * badge that opens a dialog showing the conversation's safety number.
 *
 * Plain words outside, expert string inside: the trigger and copy explain
 * the check in terms of what the user actually does (compare a number with
 * the person over a channel you both trust), while the safety number itself
 * is shown verbatim for the technically minded.
 *
 * The user confirms they have verified it; until then the badge reads
 * "Verify it's really them". Closing the dialog without confirming is
 * non-blocking.
 */
export function SafetyNumberDialog({
  safetyNumber,
  verified,
}: SafetyNumberDialogProps): React.ReactElement {
  const { controller } = useChat();
  const [open, setOpen] = React.useState(false);

  function handleConfirm(): void {
    if (controller === null) return;
    controller.markSafetyNumberVerified();
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant={verified ? "outline" : "secondary"}
            size="sm"
            aria-label={verified ? "Peer verified" : "Verify it's really them"}
            data-testid={TESTIDS.verifyPeer}
          />
        }
      >
        {verified ? <ShieldCheckIcon className="size-3" /> : <ShieldIcon className="size-3" />}
        <span className="text-xs">{verified ? "Verified" : "Verify it's really them"}</span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Verify it's really them</DialogTitle>
          <DialogDescription>
            Check this safety number with the other person over a channel you both trust — in
            person, on a call, anywhere except this chat. If the numbers match, no one is sitting
            between you.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <pre
            className="break-all rounded-md bg-muted p-3 text-center font-mono text-xs leading-6"
            aria-label="Safety number"
          >
            {safetyNumber}
          </pre>
          <p className="text-muted-foreground text-xs leading-5">
            The number is different for every conversation. If it does not match on both sides,
            leave the chat — someone may be relaying your messages.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button onClick={handleConfirm} disabled={verified}>
            {verified ? "Already verified" : "The numbers match"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
