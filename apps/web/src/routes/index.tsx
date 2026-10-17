import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { AppShell } from "@/features/chat/ui/app-shell";
import { readInvitationFragment } from "@/features/chat/ui/invitation-fragment";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

/**
 * The home route renders the app shell. The shell decides what the main pane
 * shows (active chat vs empty state) based on `state.activeConversationId`.
 *
 * Invitation-hash joining still runs here: once the controller is ready, we
 * look for `#<hex>` in the URL fragment and call `controller.joinConversation`.
 * The hash never reaches the server (browsers withhold it), so this only runs
 * in the browser. `hashchange` covers the case of a user pasting an invitation
 * link into an already-open tab.
 */
function HomeComponent(): React.ReactElement {
  const { controller, state, ready } = useChat();
  // R10F6/R11F1 (Phase 9): consumed-fragment ref, NOT a boolean latch. The old
  // `joinedRef` latched on ANY non-null active id AND before the join settled,
  // never reset — a failed join could never retry, and pasting a link into the
  // tab after leaving a conversation was silently dead for the page's whole
  // lifetime (the `hashchange` listener below exists for exactly that case).
  // This ref records WHICH fragment was consumed so only re-processing the
  // SAME fragment is skipped; it resets on join failure and on the
  // activeId → null transition (see the effect below).
  const consumedFragmentRef = React.useRef<string | null>(null);

  // Gate on the active id rather than the deprecated flat mirror: the active
  // session is what the shell renders, so once it is non-null we stop trying
  // to join from the fragment.
  const activeId = state.activeConversationId;

  const tryJoin = React.useCallback(() => {
    if (!ready || controller === null) return;
    if (activeId !== null) return;
    if (typeof window === "undefined") return;
    const fragment = readInvitationFragment(window.location.hash);
    if (fragment === null) return;
    if (consumedFragmentRef.current === fragment) return;
    consumedFragmentRef.current = fragment;
    // R11F2 (Phase 9): scrub the hash IMMEDIATELY — before the async join —
    // so BOTH outcomes leave no `#<hex>~<code>` (conversation id + PAKE code)
    // in the address bar or synced browser history. Previously replaceState
    // ran only in the .catch, so a successful join kept the credential-laden
    // fragment visible AND made a reload re-trigger `joinConversation`.
    // `history.replaceState` does not fire `hashchange`, so the scrub cannot
    // re-enter this callback.
    window.history.replaceState(null, "", window.location.pathname);
    void controller.joinConversation(fragment).catch((err: unknown) => {
      // Un-consume so re-pasting the same link retries — a transient failure
      // must not permanently latch the fragment.
      consumedFragmentRef.current = null;
      toast.error("Could not join conversation", {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }, [ready, controller, activeId]);

  React.useEffect(() => {
    tryJoin();
  }, [tryJoin]);

  // R10F6/R11F1: when the active session ends (leave/teardown), un-consume
  // the fragment so a re-pasted invitation — even the same link — joins
  // again. The reset must key on the non-null → null TRANSITION, not on
  // `activeId === null` per se: consumedFragmentRef is written while a join
  // is still in flight (activeId still null), and an unconditional reset
  // would let a stray effect re-fire tryJoin into a double join.
  const lastActiveRef = React.useRef(activeId);
  React.useEffect(() => {
    if (lastActiveRef.current !== null && activeId === null) {
      consumedFragmentRef.current = null;
    }
    lastActiveRef.current = activeId;
  }, [activeId]);

  // A user already on `/` who then opens an invitation link (same path, only
  // the hash changes) would not re-trigger the effect above because its deps
  // do not include the raw hash string. Listen for `hashchange` so a
  // late-arriving fragment is honored.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    function onHashChange(): void {
      tryJoin();
    }
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [tryJoin]);

  return <AppShell />;
}
