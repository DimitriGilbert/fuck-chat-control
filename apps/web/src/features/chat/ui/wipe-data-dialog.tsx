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
 */
export function WipeDataAlertDialog({
  open,
  mode,
  onOpenChange,
  onConfirm,
}: WipeDataAlertDialogProps): React.ReactElement {
  const { controller } = useChat();

  const isAll = mode === "all";
  const title = isAll ? "Wipe all local data?" : "Clear current conversation?";
  const description = isAll
    ? "Every conversation and message stored in this browser will be deleted. The server has no copy. Note: the AES-256 key that protects your history is held separately by this browser profile; clearing browser site data later will destroy it and render any remaining ciphertext unrecoverable. To preserve your identity and history, export an encrypted bundle first. This action cannot be undone."
    : "The active conversation's history will be removed from this browser. The at-rest encryption key that protects your remaining conversations is retained. This action cannot be undone.";

  function handleConfirm(): void {
    if (controller === null || mode === null) return;
    const promise = mode === "all" ? controller.clearAll() : controller.clearConversation();
    void promise
      .then(() => {
        toast.success(isAll ? "All data wiped" : "Conversation cleared");
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
            {isAll ? "Wipe all" : "Clear"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
