import * as React from "react";
import { toast } from "sonner";

import type { ChatController } from "@fuck-eu-chat-control/chat-runtime/runtime/chat-controller";
import type { ConversationId } from "@fuck-eu-chat-control/chat-runtime/protocol/types";
import type { GroupId } from "@fuck-eu-chat-control/chat-runtime/group/types";
import { readInvitationFragment } from "@/features/chat/ui/invitation-fragment";

/**
 * What the home route renders while an invitation link awaits the user's
 * mode choice (protocol-v2 §8). The link grammar is identical for pair and
 * group (`#<hex>(~<code>)?`); pair-vs-group is decided by WHICH join the
 * user picks, not by the link bytes.
 */
export interface PendingInvitationJoin {
  /** The bare fragment (`<hex>(~<code>)?`), already case-normalized. */
  readonly fragment: string;
  /** True while a join attempt is in flight (both actions disable). */
  readonly joining: boolean;
  /** Join the link as a 1:1 conversation — `controller.joinConversation`. */
  readonly joinAsPair: () => void;
  /** Join the link as a group — `controller.joinGroup`. */
  readonly joinAsGroup: () => void;
  /** Decline the link entirely; re-pasting it re-prompts. */
  readonly dismiss: () => void;
}

/**
 * Invitation-hash joining for the home route, extended for protocol-v2:
 * instead of immediately calling `controller.joinConversation`, a detected
 * `#<hex>(~<code>)?` fragment becomes a PENDING join — the route renders the
 * mode-choice dialog ({@link JoinModeDialog}) and the user's pick decides
 * `joinConversation` (1:1) vs `joinGroup` (group). The hash never reaches
 * the server (browsers withhold it), so this only runs in the browser.
 * `hashchange` covers a user pasting an invitation link into an
 * already-open tab.
 *
 * R10F6/R11F1 (Phase 9): consumed-fragment ref, NOT a boolean latch. Only
 * re-processing the SAME fragment is skipped; the ref resets on join
 * failure, on dismiss, and on the active-surface → null transition, so a
 * failed or declined link can be retried by re-pasting, and a link pasted
 * after leaving a session still prompts.
 *
 * R11F2: the credential-laden hash is scrubbed IMMEDIATELY when the
 * fragment is consumed — before any join runs — so neither outcome leaves
 * `#<hex>~<code>` in the address bar or synced browser history.
 * `history.replaceState` does not fire `hashchange`, so the scrub cannot
 * re-enter the detector.
 */
export function useInvitationJoin(
  controller: ChatController | null,
  ready: boolean,
  activeId: ConversationId | null,
  activeGroupId: GroupId | null,
): PendingInvitationJoin | null {
  const consumedFragmentRef = React.useRef<string | null>(null);
  const [pendingFragment, setPendingFragment] = React.useState<string | null>(null);
  const [joining, setJoining] = React.useState(false);

  // "An active surface" gates the detector: a live conversation OR a live
  // group means the shell is showing something — the fragment is neither
  // consumed nor scrubbed while one is active (same contract as the pre-v2
  // hook, so the link still prompts once the user leaves).
  const hasActive = activeId !== null || activeGroupId !== null;

  // Gate on the active surface rather than the deprecated flat mirror: the
  // active session/group is what the shell renders, so once one is non-null
  // we stop watching the fragment.
  const detect = React.useCallback(() => {
    if (!ready || controller === null) return;
    if (hasActive) return;
    if (typeof window === "undefined") return;
    const fragment = readInvitationFragment(window.location.hash);
    if (fragment === null) return;
    if (consumedFragmentRef.current === fragment) return;
    consumedFragmentRef.current = fragment;
    // Scrub the hash before the choice UI renders — a pending decision must
    // not leave the credential-bearing fragment in the address bar.
    window.history.replaceState(null, "", window.location.pathname);
    setPendingFragment(fragment);
  }, [ready, controller, hasActive]);

  React.useEffect(() => {
    detect();
  }, [detect]);

  // When an active surface appears (a join landing, a sidebar select, a
  // fresh start), the pending choice is moot — drop it.
  React.useEffect(() => {
    if (hasActive) {
      setPendingFragment(null);
      setJoining(false);
    }
  }, [hasActive]);

  // R10F6/R11F1: when the active surface ends (leave/teardown), un-consume
  // the fragment so a re-pasted invitation — even the same link — prompts
  // again. The reset must key on the some→none TRANSITION, not on
  // `hasActive === false` per se: consumedFragmentRef is written while a
  // prompt is still open, and an unconditional reset would let a stray
  // effect re-fire detect into a re-prompt.
  const lastActiveRef = React.useRef(hasActive);
  React.useEffect(() => {
    if (lastActiveRef.current && !hasActive) {
      consumedFragmentRef.current = null;
    }
    lastActiveRef.current = hasActive;
  }, [hasActive]);

  // A user already on `/` who then opens an invitation link (same path, only
  // the hash changes) would not re-trigger the effect above because its deps
  // do not include the raw hash string. Listen for `hashchange` so a
  // late-arriving fragment is honored.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    function onHashChange(): void {
      detect();
    }
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [detect]);

  const pending = pendingFragment;

  const runJoin = React.useCallback(
    (mode: "pair" | "group"): void => {
      if (controller === null || pending === null || joining) return;
      setJoining(true);
      const attempt =
        mode === "group" ? controller.joinGroup(pending) : controller.joinConversation(pending);
      void attempt
        .then(() => {
          setPendingFragment(null);
        })
        .catch((err: unknown) => {
          // Un-consume so re-pasting the same link retries — a transient
          // failure must not permanently latch the fragment. The prompt
          // stays open so the other mode is still one click away.
          consumedFragmentRef.current = null;
          toast.error(mode === "group" ? "Could not join group" : "Could not join conversation", {
            description: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          setJoining(false);
        });
    },
    [controller, pending, joining],
  );

  const joinAsPair = React.useCallback((): void => {
    runJoin("pair");
  }, [runJoin]);

  const joinAsGroup = React.useCallback((): void => {
    runJoin("group");
  }, [runJoin]);

  const dismiss = React.useCallback((): void => {
    // Declining un-consumes the fragment: the hash is already scrubbed, so
    // re-pasting the same link (a fresh hashchange) re-prompts rather than
    // being silently dead.
    consumedFragmentRef.current = null;
    setPendingFragment(null);
  }, []);

  if (pending === null) return null;
  return { fragment: pending, joining, joinAsPair, joinAsGroup, dismiss };
}
