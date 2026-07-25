import { Button } from "@fuck-eu-chat-control/ui/components/button";
import { Card, CardHeader, CardTitle } from "@fuck-eu-chat-control/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@fuck-eu-chat-control/ui/components/empty";
import { CopyIcon, KeyRoundIcon, LinkIcon, ShieldCheckIcon } from "lucide-react";
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
 * Landing page body. Lead with what the user gets (a private 1:1 chat that
 * needs no account), one primary call to action, and a short honest strip
 * of how it stays private. The wall of caveats lives on /docs/security and
 * /docs/deployment.
 */
export function Landing({ onResume }: LandingProps): React.ReactElement {
  const { state, ready } = useChat();
  const conversations = state.conversations;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <header className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">fck-chat-control</h1>
        <p className="text-muted-foreground max-w-[58ch] text-base leading-7 sm:text-lg sm:leading-8">
          A private 1:1 chat that needs no account, no phone number, no app. Open a link, talk,
          close the tab. The server that hooks you up is gone from the conversation the moment you
          connect.
        </p>
        <div className="text-muted-foreground text-xs">
          Built against "chat control" - the EU's mass-scanning push. The server can&apos;t read
          what it never receives.
        </div>
      </header>

      <section className="mt-8">
        <StartConversationPanel ready={ready} />
      </section>

      <section className="mt-10 grid gap-3 sm:grid-cols-3">
        <FactCard
          icon={<LinkIcon className="size-4" />}
          title="No account, ever"
          body="No phone, no email, no profile. An invitation is a random id in a URL - nothing about you travels with it."
        />
        <FactCard
          icon={<ShieldCheckIcon className="size-4" />}
          title="Server can't read it"
          body="Messages are encrypted with keys that live in your browser. The broker relays the handshake and steps out of the data path."
        />
        <FactCard
          icon={<KeyRoundIcon className="size-4" />}
          title="You verify, not us"
          body="After connecting, both sides show the same safety number. Compare it in person or by voice. If it matches, the line is clean."
        />
      </section>

      <section className="mt-10">
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

      <footer className="text-muted-foreground mt-12 border-t border-border pt-4 text-xs">
        v1 is text-only and direct (STUN, no TURN relay). The sharp edges - symmetric NAT, at-rest
        key handling, the lack of PAKE - are documented on the{" "}
        <a
          href="/docs/security"
          className="text-primary underline underline-offset-4 hover:opacity-80"
        >
          security
        </a>{" "}
        and{" "}
        <a
          href="/docs/deployment"
          className="text-primary underline underline-offset-4 hover:opacity-80"
        >
          deployment
        </a>{" "}
        pages.
      </footer>
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
  readonly onResume: (conversationId: ConversationRecord) => void;
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
