import { Button } from "@fuck-eu-chat-control/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@fuck-eu-chat-control/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fuck-eu-chat-control/ui/components/tabs";
import { Settings2Icon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { AuthMode } from "@/features/chat/protocol/types";
import type { ImportResult } from "@/features/chat/store";
import { ExportBundleDialog } from "@/features/chat/ui/export-bundle-dialog";
import { ImportBundleDialog } from "@/features/chat/ui/import-bundle-dialog";
import { WipeDataAlertDialog } from "@/features/chat/ui/wipe-data-dialog";

/**
 * The trigger button in the chat status bar. Owns the Sheet's open state so
 * the sheet can be opened from a single anchor and closed by any action.
 */
export function SettingsSheetTrigger(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Open settings" />}>
        <Settings2Icon />
      </SheetTrigger>
      <SettingsSheetContent onClose={() => setOpen(false)} />
    </Sheet>
  );
}

interface SettingsSheetContentProps {
  readonly onClose: () => void;
}

function SettingsSheetContent({ onClose }: SettingsSheetContentProps): React.ReactElement {
  const { state } = useChat();
  const [exportOpen, setExportOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [wipeMode, setWipeMode] = React.useState<"current" | "all" | null>(null);

  return (
    <SheetContent side="right" className="w-full sm:max-w-md">
      <SheetHeader>
        <SheetTitle>Settings</SheetTitle>
        <SheetDescription>
          Identity, security, and data controls for this browser profile.
        </SheetDescription>
      </SheetHeader>
      <Tabs defaultValue="security" className="flex-1 overflow-hidden px-4 pb-4">
        <TabsList>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>

        <TabsContent value="security" className="mt-4 space-y-4">
          <SecuritySection
            safetyNumber={state.safetyNumber}
            verified={state.safetyNumberVerified}
            authMode={state.active?.authMode ?? AuthMode.SafetyNumberOnly}
          />
        </TabsContent>

        <TabsContent value="data" className="mt-4 space-y-4">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Portable bundle</h3>
            <p className="text-muted-foreground text-xs">
              Export an encrypted bundle (passphrase-protected) to move your identity and history to
              another browser. Import merges or replaces local data.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
                Export bundle
              </Button>
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                Import bundle
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Danger zone</h3>
            <p className="text-muted-foreground text-xs">
              Clearing the current conversation deletes its history. Wiping all removes every
              conversation and message from this browser. The server has no copy. The AES-256
              at-rest key that protects your history is held separately by this browser profile;
              clearing browser site data will destroy it.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" size="sm" onClick={() => setWipeMode("current")}>
                Clear current conversation
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setWipeMode("all")}>
                Wipe all data
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <ExportBundleDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ImportBundleDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(result: ImportResult) => {
          reportImportResult(result);
        }}
      />
      <WipeDataAlertDialog
        open={wipeMode !== null}
        mode={wipeMode}
        onOpenChange={(next: boolean) => {
          if (!next) setWipeMode(null);
        }}
        onConfirm={() => {
          onClose();
          setWipeMode(null);
        }}
      />
    </SheetContent>
  );
}

function reportImportResult(result: ImportResult): void {
  const conflictNote =
    result.conflicts.length > 0 ? ` (${result.conflicts.length} identity conflicts)` : "";
  // SEC-3: when the bundle carried a device-identity private scalar, the
  // controller has already adopted it by the time we render this toast — surface
  // that as an explicit line so the user knows their identity moved with the
  // bundle (rather than silently switching keys on the next session).
  const identityNote = result.deviceIdentity !== null ? " Identity restored from bundle." : "";
  toast.success("Bundle imported", {
    description: `${result.conversationsAdded + result.conversationsMerged} conversations, ${result.messagesImported} messages${conflictNote}.${identityNote}`,
  });
}

interface SecuritySectionProps {
  readonly safetyNumber: string | null;
  readonly verified: boolean;
  readonly authMode: AuthMode;
}

function SecuritySection({
  safetyNumber,
  verified,
  authMode,
}: SecuritySectionProps): React.ReactElement {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Conversation safety number</h3>
        {safetyNumber === null ? (
          <p className="text-muted-foreground text-xs">
            No active conversation. A safety number is generated for each conversation once the
            handshake completes.
          </p>
        ) : (
          <>
            <pre className="bg-muted break-all rounded-none p-2 font-mono text-xs">
              {safetyNumber}
            </pre>
            <p className="text-muted-foreground text-xs">
              {verified
                ? "You marked this safety number as verified."
                : "Unverified — compare with your peer out-of-band and verify it in the chat view."}
            </p>
          </>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Handshake authentication</h3>
        {/* SEC-4: surface the live negotiated auth mode rather than a static
            PAKE blurb. A PAKE session carries the stronger guarantee (the
            handshake was authenticated against a malicious broker); a safety-
            number session relies on post-hoc comparison. */}
        {authMode === AuthMode.Pake ? (
          <p className="text-xs">
            <span className="text-primary font-medium">PAKE-protected.</span>{" "}
            <span className="text-muted-foreground">
              This session authenticated the handshake with a SPAKE2 password exchange keyed by the
              6-digit code shared out-of-band. The broker could not mount a MITM attack without
              knowing the code.
            </span>
          </p>
        ) : (
          <p className="text-xs">
            <span className="text-foreground font-medium">Safety number only.</span>{" "}
            <span className="text-muted-foreground">
              The handshake was not password-authenticated. Compare the safety number with your peer
              out-of-band to detect a man-in-the-middle; if it matches, the channel is secure.
            </span>
          </p>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">At-rest encryption</h3>
        <p className="text-muted-foreground text-xs">
          History is sealed with an AES-256 key held in this browser. In auto mode (the default) the
          key is stored on disk, so anyone with access to this browser profile while unlocked can
          read history. Passphrase-protected export/import lets you move data without exposing the
          raw key.
        </p>
        <p className="text-muted-foreground text-xs">
          A passphrase-locked at-rest key (entered at boot) is the safer default and is tracked for
          a follow-up release. For now, prefer exporting a bundle and clearing local data on shared
          devices.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">P2P transport</h3>
        <p className="text-muted-foreground text-xs">
          Direct WebRTC (STUN only, no TURN relay). Peers behind symmetric NAT (~10–20% of networks)
          may fail to connect; the broker only relays encrypted signaling and drops out of the data
          path once the peer connection is established.
        </p>
      </div>
    </div>
  );
}
