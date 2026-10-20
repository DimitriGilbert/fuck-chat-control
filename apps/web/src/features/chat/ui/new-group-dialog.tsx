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
import { cn } from "@fuck-eu-chat-control/ui/lib/utils";
import { LockIcon, RefreshCwIcon, UsersIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { MAX_MEMBER_DISPLAY_NAME } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import { useChat } from "@/features/chat/runtime/chat-provider";
import { clampUtf8Bytes } from "@/features/chat/ui/group-members";
import { TESTIDS } from "@/features/chat/ui/testids";

/**
 * Phase 7a (protocol-v2): the "New group" affordance and its create dialog.
 * Self-contained like {@link SettingsSheetTrigger}: the trigger button owns
 * the dialog's open state.
 *
 * The form mirrors the 1:1 extra-code UX from the invitation banner
 * (invitation-banner.tsx > ExtraCodeControl): an optional 6-digit code —
 * CSPRNG-minted by `controller.generatePakeCode()` so the sampling stays in
 * the security-relevant runtime — plus the honest "send it on a different
 * channel" warning. `name` is the local sidebar label; `displayName` is OUR
 * member name announced to the group (protocol-v2 §4.1). Neither is
 * required.
 *
 * On success `controller.startGroup` seats this device as the group author,
 * selects the group (it becomes `state.activeGroup`), and the group view's
 * invitation banner shows the link with copy affordances — the same
 * `#<hex>(~code)` grammar as 1:1.
 */
export function NewGroupButton(): React.ReactElement {
  const { controller, ready, state } = useChat();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  // Mirror the invitation banner's derived-vs-latched discipline: the code
  // field is only meaningful while `codeEnabled` is on; toggling on mints a
  // fresh CSPRNG code so the input is never left empty-but-armed.
  const [codeEnabled, setCodeEnabled] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const booting = !ready && state.error === null;
  const bootError = !ready ? state.error : null;

  // Reset the form whenever the dialog closes so a reopen starts clean.
  React.useEffect(() => {
    if (!open) {
      setName("");
      setDisplayName("");
      setCodeEnabled(false);
      setCode("");
      setBusy(false);
    }
  }, [open]);

  function handleToggleCode(): void {
    const next = !codeEnabled;
    setCodeEnabled(next);
    if (next && controller !== null && code.length === 0) {
      setCode(controller.generatePakeCode());
    }
  }

  function handleCodeChange(e: React.ChangeEvent<HTMLInputElement>): void {
    // Same sanitization as the banner's extra-code input: digits only, 6 max.
    setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
  }

  function handleRegenerateCode(): void {
    if (controller === null) return;
    setCode(controller.generatePakeCode());
  }

  async function handleCreate(): Promise<void> {
    if (controller === null || busy) return;
    if (codeEnabled && code.length !== 6) {
      toast.error("Code must be 6 digits");
      return;
    }
    setBusy(true);
    try {
      await controller.startGroup({
        ...(codeEnabled ? { code } : {}),
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
        ...(displayName.trim().length > 0 ? { displayName: displayName.trim() } : {}),
      });
      setOpen(false);
      toast.success("Group created", {
        description: "Share the invitation link with everyone you want in.",
      });
    } catch (err: unknown) {
      toast.error("Could not create group", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start"
        onClick={() => setOpen(true)}
        disabled={bootError !== null}
        data-testid={TESTIDS.newGroup}
      >
        <UsersIcon />
        New group
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next: boolean): void => {
          // No mid-flight dismissal (same discipline as the export dialog).
          if (!next && busy) return;
          setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a group</DialogTitle>
            <DialogDescription>
              Everyone in a group connects directly to everyone else — the server only relays the
              handshakes, never the messages. Share the invitation link with each person you want
              in; they all must be online to join.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="group-name">Group name (optional)</Label>
              <Input
                id="group-name"
                type="text"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                placeholder="e.g. weekend plans"
                disabled={busy}
                data-testid={TESTIDS.groupNameInput}
              />
              <p className="text-muted-foreground text-xs leading-4">
                Only you see this label — it names the sidebar row, nothing is sent to the group.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="group-display-name">Your name in this group (optional)</Label>
              <Input
                id="group-display-name"
                type="text"
                value={displayName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setDisplayName(clampUtf8Bytes(e.target.value, MAX_MEMBER_DISPLAY_NAME))
                }
                // UX hint only — maxLength counts UTF-16 units, so the real
                // 32-BYTE protocol cap is enforced in the change handler.
                maxLength={MAX_MEMBER_DISPLAY_NAME}
                placeholder="Shown to members"
                disabled={busy}
                data-testid={TESTIDS.groupDisplayNameInput}
              />
            </div>

            <label className="flex cursor-pointer items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={codeEnabled}
                onChange={handleToggleCode}
                disabled={busy}
                aria-label="Require an extra 6-digit code to join"
                className="accent-primary focus-visible:ring-ring/50 mt-0.5 size-4 rounded-sm focus-visible:ring-1 focus-visible:outline-none disabled:opacity-50"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
                  <LockIcon className="text-primary size-3.5" aria-hidden="true" />
                  Require an extra code
                </span>
                <span className="text-muted-foreground leading-4">
                  Every member will also need this 6-digit code to get in. Send it on a different
                  channel than the link — anyone who sees both can pretend to be a member.
                </span>
              </span>
            </label>

            {codeEnabled && (
              <div
                className="bg-primary/5 border-primary/30 flex flex-wrap items-center gap-1.5 rounded-md border px-3 py-2.5"
                data-slot="extra-code"
              >
                <Label
                  htmlFor="group-code-input"
                  className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide"
                >
                  Extra code
                </Label>
                <Input
                  id="group-code-input"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={code}
                  onChange={handleCodeChange}
                  disabled={busy}
                  placeholder="6 digits"
                  className={cn("h-6 w-24 font-mono text-xs tabular-nums")}
                  aria-label="Group extra code"
                  data-testid={TESTIDS.groupCodeInput}
                />
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleRegenerateCode}
                  disabled={busy}
                  className="ml-auto"
                  aria-label="Generate a different extra code"
                >
                  <RefreshCwIcon className="size-3" />
                  New code
                </Button>
              </div>
            )}
          </div>
          {booting && (
            <p className="text-muted-foreground text-xs leading-4">
              Setting up secure storage… the group can be created in a moment.
            </p>
          )}
          {bootError !== null && (
            <p role="alert" className="text-destructive text-xs leading-4">
              Something failed to load — reload the page to try again. ({bootError})
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={busy || !ready || (codeEnabled && code.length !== 6)}
              data-testid={TESTIDS.createGroup}
            >
              {busy ? "Creating…" : "Create group"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
