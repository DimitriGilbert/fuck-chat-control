import { Button } from "@fuck-eu-chat-control/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@fuck-eu-chat-control/ui/components/empty";
import { PlusIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import type { ConversationRecord } from "@/features/chat/store";

/**
 * Shown when no conversation is active. A quiet, on-brand prompt: one short
 * stance line, one primary action, one security footnote. Deliberately NOT
 * the old centered marketing wall, NOT a hero, NOT three feature cards.
 *
 * If persisted conversations exist in the repository (and none are live), a
 * compact list offers to resume each one. This is the home base; the sidebar
 * stays focused on currently-live sessions.
 */
export function EmptyState(): React.ReactElement {
  const { state, controller, ready } = useChat();
  // Show every conversation — the same set the sidebar lists — so the center
  // and sidebar stay in sync. (Previously this excluded live sessions, which
  // made the two lists show different things.)
  const resumable = state.conversations;

  function handleResume(record: ConversationRecord): void {
    if (controller === null) return;
    void controller.resumeConversation(record.id).catch((err: unknown) => {
      toast.error("Could not resume", {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }

  function handleLeave(record: ConversationRecord): void {
    if (controller === null) return;
    // clearConversation deletes the persisted record and tears down any live
    // session — the persisted row vanishes from this list on the next emit.
    void controller.clearConversation(record.id).catch((err: unknown) => {
      toast.error("Could not remove", {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }

  function handleStart(): void {
    if (controller === null) return;
    void controller.startConversation().catch((err: unknown) => {
      toast.error("Could not start", {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return (
    <Empty className="justify-center">
      {/* Composed container: one card-like surface holding the headline, copy,
          and primary CTA. Turns the surrounding negative space into deliberate
          framing instead of a void, without clustering the pane with cards. */}
      <div className="bg-card border-border mx-auto flex w-full max-w-[480px] flex-col items-center gap-5 rounded-xl border p-8 text-center shadow-sm">
        <EmptyHeader className="max-w-none gap-2">
          <EmptyTitle className="text-foreground text-2xl font-semibold tracking-tight">
            Private chat, no account.
          </EmptyTitle>
        </EmptyHeader>
        <EmptyContent className="max-w-[40ch] gap-3">
          <p className="text-muted-foreground text-sm leading-6">
            Start a 1:1 conversation and share the link. End-to-end encrypted; the server only
            relays the handshake.
          </p>
          <p className="text-muted-foreground text-xs leading-5">
            Read the{" "}
            <a
              href="/docs/security"
              className="text-primary underline underline-offset-4 hover:opacity-80"
            >
              security notes
            </a>{" "}
            before relying on it for anything sensitive.
          </p>
          <p className="text-muted-foreground text-xs leading-5">
            Fully open source &mdash;{" "}
            <a
              href="https://github.com/DimitriGilbert/fuck-chat-control"
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline underline-offset-4 hover:opacity-80"
            >
              read the code
            </a>
            , audit it, fork it, or run it yourself. No binary you have to trust on faith.
          </p>
        </EmptyContent>

        {/* Primary CTA. Visible at all sizes: the empty state is the home base
            and should invite action everywhere. Starts the conversation
            directly — same action as the sidebar's Start button, so both
            buttons with the same label do the same thing. */}
        <Button
          variant="default"
          size="default"
          className="mt-1 w-full"
          onClick={handleStart}
          disabled={!ready}
        >
          <PlusIcon />
          Start a conversation
        </Button>
      </div>

      {resumable.length > 0 && (
        <div className="mt-2 w-full max-w-[480px]">
          <h2 className="text-muted-foreground mb-2 px-1 text-xs font-medium uppercase tracking-wide">
            Previous conversations
          </h2>
          <ul className="flex flex-col gap-1">
            {resumable.map((record) => (
              <li key={resumeKey(record)}>
                <ResumeRow
                  record={record}
                  onResume={() => handleResume(record)}
                  onLeave={() => handleLeave(record)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Empty>
  );
}

interface ResumeRowProps {
  readonly record: ConversationRecord;
  readonly onResume: () => void;
  readonly onLeave: () => void;
}

function ResumeRow({ record, onResume, onLeave }: ResumeRowProps): React.ReactElement {
  const label = record.displayName ?? "Untitled conversation";
  const when = new Date(record.createdAt).toLocaleString();
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="text-muted-foreground text-xs">{when}</div>
      </div>
      <Button variant="outline" size="sm" onClick={onResume}>
        Resume
      </Button>
      <Button variant="ghost" size="sm" onClick={onLeave}>
        Leave
      </Button>
    </div>
  );
}

function resumeKey(record: ConversationRecord): string {
  // ConversationId is a Uint8Array; convert to hex for React keys.
  const id = record.id;
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i].toString(16).padStart(2, "0");
  }
  return hex;
}
