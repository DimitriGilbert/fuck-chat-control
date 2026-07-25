import { Button } from "@fuck-eu-chat-control/ui/components/button";
import { Card, CardHeader, CardTitle } from "@fuck-eu-chat-control/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@fuck-eu-chat-control/ui/components/empty";
import { CopyIcon, KeyRoundIcon, NetworkIcon, ShieldOffIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { conversationIdToHex } from "@/features/chat/orchestrator/invitation";
import type { ConversationRecord } from "@/features/chat/store";
import { StartConversationPanel } from "@/features/chat/ui/start-conversation-panel";

interface LandingProps {
  readonly onResume: (conversationId: ConversationRecord) => void;
}

/**
 * Landing page body. Replaces the ASCII banner with: a short explainer
 * (what / why / security / limitations), the primary start-conversation
 * panel, and the stored-conversation list with resume.
 */
export function Landing({ onResume }: LandingProps): React.ReactElement {
  const { state, ready } = useChat();
  const conversations = state.conversations;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">fck-chat-control</h1>
        <p className="text-muted-foreground text-sm">
          Serverless, end-to-end-encrypted, no-account peer-to-peer chat. No phone number, no email,
          no central directory. The broker only relays encrypted signaling and drops out of the data
          path once your browser and your peer's are connected directly.
        </p>
      </header>

      <section className="mt-6 grid gap-3 sm:grid-cols-2">
        <FactCard
          icon={<KeyRoundIcon className="size-4" />}
          title="Why this exists"
          body="Chat-control proposals mandate client-side scanning and identity checks that break end-to-end encryption. This app is a counter-example: the server never sees content, holds no identity, and cannot decrypt history — because it is never in the path."
        />
        <FactCard
          icon={<ShieldOffIcon className="size-4" />}
          title="Security model"
          body="Each side generates a device key. After the handshake, both sides show the same safety number. Verify it out-of-band (in person, by phone). v1 has no PAKE and no verification code in the link — whoever joins first is accepted."
        />
        <FactCard
          icon={<NetworkIcon className="size-4" />}
          title="STUN-only (no TURN)"
          body="Connections use direct WebRTC with STUN. Peers behind symmetric NAT (~10–20% of networks) may fail to connect. There is no TURN relay, so both peers must be reachable directly."
        />
        <FactCard
          icon={<CopyIcon className="size-4" />}
          title="At-rest encryption"
          body="History is sealed with an AES-256 key kept in this browser. Auto mode (the default) stores that key on disk, so an unlocked browser profile can be read. Passphrase-protected export/import lets you move data safely."
        />
      </section>

      <section className="mt-6">
        <StartConversationPanel ready={ready} />
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-medium">Conversations in this browser</h2>
        {conversations.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No stored conversations</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <p className="text-muted-foreground text-sm">
                Start one above, or open an invitation link (a URL with a <code>#</code> fragment)
                to join one.
              </p>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="divide-y divide-border rounded-none border border-border">
            {conversations.map((conversation) => (
              <li key={conversationIdToHex(conversation.id)}>
                <ConversationRow conversation={conversation} onResume={onResume} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface FactCardProps {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly body: string;
}

function FactCard({ icon, title, body }: FactCardProps): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {icon}
          {title}
        </CardTitle>
        <p className="text-muted-foreground text-xs">{body}</p>
      </CardHeader>
    </Card>
  );
}

interface ConversationRowProps {
  readonly conversation: ConversationRecord;
  readonly onResume: (conversation: ConversationRecord) => void;
}

function ConversationRow({ conversation, onResume }: ConversationRowProps): React.ReactElement {
  const label =
    conversation.displayName ??
    (conversation.peer
      ? `${conversation.peer.fingerprint.slice(0, 12)}…`
      : "Untitled conversation");
  const created = new Date(conversation.createdAt).toLocaleString();

  async function handleCopyId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(conversationIdToHex(conversation.id));
      toast.success("Conversation id copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="text-muted-foreground text-xs">{created}</div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy conversation id"
        onClick={() => {
          void handleCopyId();
        }}
      >
        <CopyIcon />
      </Button>
      <Button variant="outline" size="sm" onClick={() => onResume(conversation)}>
        Resume
      </Button>
    </div>
  );
}
