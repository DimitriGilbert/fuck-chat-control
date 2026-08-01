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
import { ImportMode } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ImportMode as ImportModeType } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ImportResult } from "@fuck-eu-chat-control/chat-runtime/store";

interface ImportBundleDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onImported: (result: ImportResult) => void;
}

/**
 * Prompts for a bundle file + passphrase, calls
 * `controller.importBundle`. Default mode is Merge; Replace is offered behind
 * an explicit toggle since it destroys local data.
 */
export function ImportBundleDialog({
  open,
  onOpenChange,
  onImported,
}: ImportBundleDialogProps): React.ReactElement {
  const { controller } = useChat();
  const [bundle, setBundle] = React.useState<string | null>(null);
  const [filename, setFilename] = React.useState("");
  const [passphrase, setPassphrase] = React.useState("");
  const [mode, setMode] = React.useState<ImportModeType>(ImportMode.Merge);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setBundle(null);
      setFilename("");
      setPassphrase("");
      setMode(ImportMode.Merge);
      setBusy(false);
    }
  }, [open]);

  function handleFile(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file === undefined) {
      setBundle(null);
      setFilename("");
      return;
    }
    setFilename(file.name);
    void file
      .text()
      .then((text: string) => {
        setBundle(text);
      })
      .catch(() => {
        setBundle(null);
        toast.error("Could not read file");
      });
  }

  function handleImport(): void {
    if (controller === null) return;
    if (bundle === null) return;
    if (passphrase.length === 0) return;
    setBusy(true);
    void controller
      .importBundle(passphrase, bundle, mode)
      .then((result: ImportResult) => {
        onImported(result);
        onOpenChange(false);
      })
      .catch((err: unknown) => {
        toast.error("Import failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        setBusy(false);
      });
  }

  const canImport = bundle !== null && passphrase.length > 0 && !busy;

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean): void => {
        // R10/F2: prevent dismissal (overlay click / Esc) while an import is
        // in flight — closing mid-import would tear down the dialog before the
        // promise settles and leak a hanging state. The explicit Cancel
        // button stays disabled via `disabled={busy}`.
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import encrypted bundle</DialogTitle>
          <DialogDescription>
            Select a previously exported bundle file and enter its passphrase.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="import-file">Bundle file</Label>
            <Input
              id="import-file"
              type="file"
              accept="application/json,.json"
              onChange={handleFile}
              disabled={busy}
            />
            {filename !== "" && <p className="text-muted-foreground text-xs">Loaded: {filename}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="import-passphrase">Passphrase</Label>
            <Input
              id="import-passphrase"
              type="password"
              value={passphrase}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassphrase(e.target.value)}
              autoComplete="off"
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label>Conflict mode</Label>
            <div className="flex gap-2">
              <ModeButton
                active={mode === ImportMode.Merge}
                onClick={() => setMode(ImportMode.Merge)}
                label="Merge"
                description="add new, keep existing"
              />
              <ModeButton
                active={mode === ImportMode.Replace}
                onClick={() => setMode(ImportMode.Replace)}
                label="Replace"
                description="wipe local first"
                destructive
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={!canImport}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ModeButtonProps {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly label: string;
  readonly description: string;
  readonly destructive?: boolean;
}

function ModeButton(props: ModeButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-active={props.active}
      className={
        props.destructive
          ? "text-destructive border-destructive data-active:bg-destructive data-active:text-destructive-foreground flex-1 rounded-none border px-2 py-1 text-xs data-active:border-transparent"
          : "border-border data-active:bg-primary data-active:text-primary-foreground flex-1 rounded-none border px-2 py-1 text-xs data-active:border-transparent"
      }
    >
      <div className="font-medium">{props.label}</div>
      <div className="text-muted-foreground data-active:text-inherit text-xs">
        {props.description}
      </div>
    </button>
  );
}
