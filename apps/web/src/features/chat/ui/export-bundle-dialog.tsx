import { Button } from "@fuck-eu-chat-control/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fuck-eu-chat-control/ui/components/dialog";
import { Input } from "@fuck-eu-chat-control/ui/components/input";
import { Label } from "@fuck-eu-chat-control/ui/components/label";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";

interface ExportBundleDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Prompts for a passphrase, calls `controller.exportBundle`, and triggers a
 * file download of the resulting JSON. The passphrase is never persisted.
 */
export function ExportBundleDialog({
  open,
  onOpenChange,
}: ExportBundleDialogProps): React.ReactElement {
  const { controller } = useChat();
  const [passphrase, setPassphrase] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setPassphrase("");
      setBusy(false);
    }
  }, [open]);

  function handleExport(): void {
    if (controller === null) return;
    if (passphrase.length === 0) return;
    setBusy(true);
    void controller
      .exportBundle(passphrase)
      .then((bundle: string) => {
        downloadBundle(bundle);
        toast.success("Bundle exported", {
          description: "Keep this file and your passphrase safe.",
        });
        onOpenChange(false);
      })
      .catch((err: unknown) => {
        toast.error("Export failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export encrypted bundle</DialogTitle>
          <DialogDescription>
            Choose a passphrase. The bundle encrypts your identity and history with Argon2id —
            without the passphrase it is unrecoverable.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="export-passphrase">Passphrase</Label>
          <Input
            id="export-passphrase"
            type="password"
            value={passphrase}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassphrase(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={busy || passphrase.length === 0}>
            {busy ? "Exporting…" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Triggers a client-side file download for the bundle JSON. Browser-only. */
function downloadBundle(bundle: string): void {
  const blob = new Blob([bundle], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.download = `fck-chat-control-bundle-${stamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
