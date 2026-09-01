import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fuck-eu-chat-control/ui/components/alert-dialog";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";

interface WipeDataAlertDialogProps {
  readonly open: boolean;
  readonly mode: "current" | "all" | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}

/**
 * Confirmation dialog for the two destructive data actions: clearing the
 * current conversation and wiping all local data. Both delete only local
 * state — the server holds no copy.
 *
 * R7/F2: there is no "clear messages but keep the conversation" operation in
 * the store — `controller.clearConversation` deletes the conversation record
 * itself including the identity binding, so the "current" description says
 * exactly that. R7/F4: with no active conversation `clearConversation`
 * resolves as a no-op, so the confirm is gated and can never toast a false
 * success.
 */
export function WipeDataAlertDialog({
  open,
  mode,
  onOpenChange,
  onConfirm,
}: WipeDataAlertDialogProps): React.ReactElement {
  const { controller, state } = useChat();

  const isAll = mode === "all";
  const title = isAll ? "Wipe all local data?" : "Clear current conversation?";
  const description = isAll
    ? "Every conversation and message stored in this browser will be deleted. The server has no copy. Note: the AES-256 key that protects your history is held separately by this browser profile; clearing browser site data later will destroy it and render any remaining ciphertext unrecoverable. To preserve your identity and history, export an encrypted bundle first. This action cannot be undone."
    : "The active conversation will be deleted from this browser, including its message history, its conversation record, and the identity binding that lets this browser resume it. The at-rest encryption key that protects your remaining conversations is retained. This action cannot be undone.";

  function handleConfirm(): void {
    if (controller === null || mode === null) return;
    // R7/F4: clearConversation() with nothing active returns immediately
    // without doing anything — confirm must not toast success for a no-op.
    // (The settings entry is disabled in that state; this guard covers the
    // race where the conversation is left while the dialog is open.)
    if (mode === "current" && state.activeConversationId === null) {
      onOpenChange(false);
      return;
    }
    const promise = mode === "all" ? controller.clearAll() : controller.clearConversation();
    void promise
      .then(() => {
        // R7/F2: state what actually happened — the conversation was deleted,
        // not merely "cleared".
        toast.success(isAll ? "All data wiped" : "Conversation deleted");
        onConfirm();
      })
      .catch((err: unknown) => {
        toast.error("Action failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={handleConfirm}>
            {isAll ? "Wipe all" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
