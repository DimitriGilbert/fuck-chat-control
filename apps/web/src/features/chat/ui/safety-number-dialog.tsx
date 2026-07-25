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

interface SafetyNumberDialogProps {
  readonly safetyNumber: string;
  readonly verified: boolean;
}

/**
 * A compact badge in the chat status bar that opens a dialog showing the
 * conversation's safety number. The user reads the number out-of-band and
 * confirms they have verified it; until then the badge shows "Unverified".
 * Closing the dialog without confirming is non-blocking.
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
            aria-label={verified ? "Safety number verified" : "Review safety number"}
          />
        }
      >
        {verified ? <ShieldCheckIcon className="size-3" /> : <ShieldIcon className="size-3" />}
        <span className="text-xs">{verified ? "Verified" : "Unverified"}</span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Safety number</DialogTitle>
          <DialogDescription>
            Compare this number with your peer over a trusted channel (in person, by phone). If the
            numbers match, your connection is end-to-end encrypted and not being relayed through a
            middleman.
          </DialogDescription>
        </DialogHeader>
        <pre className="break-all rounded-none bg-muted p-3 text-center font-mono text-xs">
          {safetyNumber}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button onClick={handleConfirm} disabled={verified}>
            {verified ? "Already verified" : "I've verified this"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
