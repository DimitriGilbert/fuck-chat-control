import { Button } from "@fuck-eu-chat-control/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@fuck-eu-chat-control/ui/components/card";
import { CopyIcon, PlusIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { ConnectionState } from "@/features/chat/signaling/state-machine";

interface StartConversationPanelProps {
  readonly ready: boolean;
}

/**
 * Renders the start-conversation affordance. Once an invitation exists, it
 * shows the shareable link with a copy button and a "waiting for peer" hint
 * driven by the connection state.
 *
 * No QR encoder is available in the dependency tree (checked package.json) and
 * the plan permits omitting QR for v1 when no approved encoder exists, so the
 * invitation is rendered as a large, selectable, copyable link instead.
 */
export function StartConversationPanel({ ready }: StartConversationPanelProps): React.ReactElement {
  const { controller, state } = useChat();
  const invitation = state.invitation;
  const waiting =
    state.connectionState === ConnectionState.Waiting ||
    state.connectionState === ConnectionState.Signaling;

  function handleStart(): void {
    if (controller === null) return;
    void controller.startConversation().catch((err: unknown) => {
      toast.error("Could not start", {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async function handleCopy(): Promise<void> {
    if (invitation === null) return;
    try {
      await navigator.clipboard.writeText(invitation);
      toast.success("Invitation link copied");
    } catch {
      toast.error("Clipboard unavailable", {
        description: "Copy the link from the address bar or select it manually.",
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Start a conversation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {invitation === null ? (
          <>
            <p className="text-muted-foreground text-sm">
              Generate an invitation link and share it over any trusted channel. The link carries
              only a random conversation id — no identity, no key material. The handshake happens
              peer-to-peer once your peer opens it.
            </p>
            <Button onClick={handleStart} disabled={!ready}>
              <PlusIcon className="size-4" />
              Start a conversation
            </Button>
          </>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              {waiting
                ? "Waiting for your peer to join. Keep this tab open."
                : "Invitation ready. Share it with your peer."}
            </p>
            <div className="flex items-stretch gap-2">
              <input
                readOnly
                value={invitation}
                onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-none border border-input bg-background px-2 py-1 font-mono text-xs"
                aria-label="Invitation link"
              />
              <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
                <CopyIcon className="size-4" />
                Copy link
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              The <code>#</code> fragment stays in your peer's URL bar and is never sent to the
              server.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
