import { Button } from "@fuck-eu-chat-control/ui/components/button";
import { Input } from "@fuck-eu-chat-control/ui/components/input";
import { Label } from "@fuck-eu-chat-control/ui/components/label";
import { cn } from "@fuck-eu-chat-control/ui/lib/utils";
import { CheckIcon, CopyIcon, LockIcon, RefreshCwIcon, Share2Icon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useChat } from "@/features/chat/runtime/chat-provider";
import { ConnectionState } from "@fuck-eu-chat-control/chat-runtime/signaling/state-machine";
import { TESTIDS } from "@/features/chat/ui/testids";

/**
 * The invitation panel shown while the initiator waits for a peer. The route
 * has already flipped to ChatView (the conversation id is set as soon as the
 * conversation is created); without this panel the inviter has no way to
 * copy the link they just generated.
 *
 * Copy reality (ruling-corrected):
 *   - "PAKE" is renamed "extra code" in every user-facing string; the
 *     6-digit code stays VISIBLE while enabled — it is the secret the peer
 *     types, in the join critical path, not behind a details affordance.
 *   - The link stays a real readable <input> (a11y + copy verification +
 *     Tauri webviews where clipboard/share may be absent), with an explicit
 *     "Copied" state and a visible "Select all" fallback; a rejected
 *     clipboard write surfaces an inline error. navigator.share is additive
 *     only — rendered solely when the API actually exists.
 *   - Honesty: the waiting state prominently states both peers must be
 *     online simultaneously — "Keep this tab open until they join."
 *
 * Extra-code affordance: selecting the checkbox tears down the current
 * (uncoded) conversation and starts a fresh one with a CSPRNG-generated
 * code; the new invitation link carries `~<code>` in the hash so the
 * responder's `parseInvitation` runs SPAKE2 against it. The code is shown
 * on its own line with explicit "share it on a different channel" copy: an
 * attacker who intercepts the link gets the code too, so for full MITM
 * protection the code should travel a different channel than the link.
 */
export function InvitationBanner(): React.ReactElement | null {
  const { state, controller } = useChat();
  // Local input lets the inviter type a custom code (6 digits). Empty means
  // we will generate a fresh CSPRNG code on toggle. Held in component state so
  // the typing experience stays responsive independent of the controller's
  // snapshot cadence.
  const [codeDraft, setCodeDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const invitation = state.invitation;
  // Pull the active code out of the invitation BEFORE any early return so the
  // useEffect below always sees the right value (no conditional hooks).
  const hashIndex = invitation?.lastIndexOf("#") ?? -1;
  const bare = hashIndex >= 0 ? (invitation as string).slice(hashIndex + 1) : (invitation ?? "");
  const tildeIdx = bare.indexOf("~");
  const activeCode = tildeIdx >= 0 ? bare.slice(tildeIdx + 1) : null;

  // R10F1 (Phase 9): the checkbox is DERIVED from the active invitation's
  // shape rather than held in local state. A failed toggle-on used to leave
  // the box checked over an uncoded invitation (the sync effect only refires
  // when activeCode CHANGES, and a rejected startConversation leaves it
  // null). Deriving means the checkbox can never lie: checked iff the live
  // invitation actually carries a code.
  const codeEnabled = activeCode !== null;

  // Sync the custom-code input to whatever the active invitation carries.
  // This keeps the panel honest if the conversation is replaced externally.
  React.useEffect(() => {
    if (activeCode !== null) setCodeDraft(activeCode);
  }, [activeCode]);

  if (invitation === null) return null;
  // Hide once the peer is connected or the session has dropped.
  if (
    state.connectionState === ConnectionState.Connected ||
    state.connectionState === ConnectionState.Disconnected
  ) {
    return null;
  }
  // After the null/hidden guards above, `invitation` is non-null and the
  // session is still waiting/handshaking. Bind a narrowed alias so the
  // closure handlers below get a `string` type.
  const activeInvitation: string = invitation;

  async function copyCode(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Code copied");
    } catch {
      // Non-fatal: the code is short enough to type by hand.
    }
  }

  /**
   * Apply the user's extra-code choice: leave the current uncoded
   * conversation and start a fresh one with the chosen code. The
   * orchestrator's `start()` requires the code up front (the authenticated
   * handshake state must be ready before the peer arrives), so we cannot
   * mutate the existing invitation in place.
   *
   * Removing the code reverses the flow: leave the coded conversation and
   * start a fresh uncoded one.
   *
   * Phase 3b (CR-4): the 6-digit code is generated by the controller's
   * `generatePakeCode()` so the CSPRNG sampling + modular reduction live in
   * the security-relevant runtime, not the render layer.
   *
   * `explicitCode` (R10F1, Phase 9) lets the caller hand in a code that was
   * JUST generated. Without it the code came from `codeDraft` — but
   * `setCodeDraft` is asynchronous, so a regenerate that set state and called
   * this in the same tick applied the STALE draft and silently re-issued the
   * old code.
   */
  async function applyCodeChoice(next: boolean, explicitCode?: string): Promise<void> {
    if (controller === null || busy) return;
    setBusy(true);
    try {
      const currentId = state.activeConversationId;
      if (currentId !== null) {
        controller.leaveConversation(currentId);
      }
      if (next) {
        const code =
          explicitCode ??
          (codeDraft.trim().length === 6 ? codeDraft.trim() : controller.generatePakeCode());
        setCodeDraft(code);
        await controller.startConversation({ code });
        toast.success("Extra code added", {
          description: "Send the code on a different channel than the link.",
        });
      } else {
        await controller.startConversation();
        toast.success("Invitation ready");
      }
    } catch (err: unknown) {
      toast.error("Could not update invitation", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  function handleToggleCode(): void {
    // No local resync needed: `codeEnabled` derives from the invitation, so a
    // failed apply leaves the checkbox reflecting reality (unchecked when no
    // coded invitation exists).
    void applyCodeChoice(!codeEnabled);
  }

  function handleRegenerateCode(): void {
    if (busy || controller === null) return;
    const fresh = controller.generatePakeCode();
    setCodeDraft(fresh);
    // Apply immediately so the invitation reflects the new code. The fresh
    // code MUST be passed explicitly — `applyCodeChoice` cannot see the
    // `setCodeDraft` above within this same tick (R10F1).
    void applyCodeChoice(true, fresh);
  }

  function handleCodeDraftChange(e: React.ChangeEvent<HTMLInputElement>): void {
    // Accept only digits, cap at 6.
    const cleaned = e.target.value.replace(/\D/g, "").slice(0, 6);
    setCodeDraft(cleaned);
  }

  function handleApplyCustomCode(): void {
    if (busy) return;
    if (codeDraft.length !== 6) {
      toast.error("Code must be 6 digits");
      return;
    }
    void applyCodeChoice(true);
  }

  return (
    <div className="border-b border-border px-3 py-3">
      <div className="border-border bg-card flex flex-col gap-3 rounded-lg border p-3">
        {/* Honest waiting state: this is the load-bearing caveat, kept
            prominent rather than buried in a footnote. */}
        <div className="flex flex-col gap-1">
          <p className="text-foreground text-sm font-medium">Keep this tab open until they join.</p>
          <p className="text-muted-foreground text-xs leading-5">
            Both of you must be online at the same time — there is no server holding the
            conversation for later. Send them this link; it opens their chat directly. The part
            after <code>#</code> never leaves their browser.
          </p>
        </div>

        <InvitationLinkField invitation={activeInvitation} />

        <ExtraCodeControl
          enabled={codeEnabled}
          activeCode={activeCode}
          codeDraft={codeDraft}
          busy={busy}
          onToggle={handleToggleCode}
          onRegenerate={handleRegenerateCode}
          onCodeDraftChange={handleCodeDraftChange}
          onApplyCustomCode={handleApplyCustomCode}
          onCopyCode={copyCode}
        />
      </div>
    </div>
  );
}

export interface InvitationLinkFieldProps {
  /** The full invitation URL to display/copy/share. */
  readonly invitation: string;
  /** navigator.share title; defaults to the 1:1 wording. */
  readonly shareTitle?: string;
}

/**
 * The verifiable link-copy field shared by the 1:1 {@link InvitationBanner}
 * and the group view's invitation panel (Phase 7a): a real readable input
 * (select-on-focus plus an explicit Select all — a11y and Tauri webviews
 * where clipboard/share may be absent), a Copy button that admits "Copied",
 * an inline error when the clipboard write is rejected, and a Share button
 * rendered solely when `navigator.share` actually exists (feature-detected
 * after mount so SSR and first paint stay identical everywhere).
 */
export function InvitationLinkField({
  invitation,
  shareTitle = "Join my private chat",
}: InvitationLinkFieldProps): React.ReactElement {
  const linkInputRef = React.useRef<HTMLInputElement | null>(null);
  // Verifiable copy: explicit "Copied" feedback plus an inline error when
  // the clipboard write is rejected. A transient "copied" state resets on a
  // timer (tracked so unmount cannot leak it).
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState<string | null>(null);
  const copyTimerRef = React.useRef<number | null>(null);
  const [canShare, setCanShare] = React.useState(false);

  React.useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(invitation);
      setCopyError(null);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2_500);
    } catch {
      setCopied(false);
      setCopyError("Could not copy automatically — select the link and copy it yourself.");
      toast.error("Clipboard unavailable", {
        description: "Select the link text and copy it manually.",
      });
    }
  }

  function handleSelectAll(): void {
    const input = linkInputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }

  async function handleShare(): Promise<void> {
    if (typeof navigator.share !== "function") return;
    try {
      await navigator.share({ url: invitation, title: shareTitle });
    } catch (err: unknown) {
      // AbortError means the user dismissed the share sheet — not an error.
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast.error("Share failed", {
        description: "Copy the link and send it yourself.",
      });
    }
  }

  return (
    <div>
      <div className="flex items-stretch gap-2">
        <input
          ref={linkInputRef}
          readOnly
          value={invitation}
          onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select()}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 min-w-0 flex-1 rounded-md border px-2 py-1 font-mono text-xs focus-visible:ring-1 focus-visible:outline-none"
          aria-label="Invitation link"
          data-testid={TESTIDS.invitationLinkInput}
        />
        <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
          {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          {copied ? "Copied" : "Copy link"}
        </Button>
        {canShare && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleShare()}
            aria-label="Share invitation link"
          >
            <Share2Icon className="size-4" />
            Share
          </Button>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={handleSelectAll}
          className="text-primary focus-visible:ring-ring/50 rounded-sm text-xs underline underline-offset-4 hover:opacity-80 focus-visible:ring-1 focus-visible:outline-none"
        >
          Select all
        </button>
        <span aria-live="polite" className="text-muted-foreground text-xs">
          {copied ? "Link copied to clipboard." : ""}
        </span>
      </div>
      {copyError !== null && (
        <p className="text-destructive mt-1 text-xs" role="alert">
          {copyError}
        </p>
      )}
    </div>
  );
}

interface ExtraCodeControlProps {
  readonly enabled: boolean;
  readonly activeCode: string | null;
  readonly codeDraft: string;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onRegenerate: () => void;
  readonly onCodeDraftChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  readonly onApplyCustomCode: () => void;
  readonly onCopyCode: (code: string) => void;
}

/**
 * The extra-code affordance. A single checkbox — "Require an extra code" —
 * and, while enabled, the 6-digit code rendered large and VISIBLE: it is the
 * secret the peer types, in the join critical path. Regenerate / custom-code
 * actions sit beside it, along with the honest out-of-band warning.
 */
function ExtraCodeControl(props: ExtraCodeControlProps): React.ReactElement {
  const {
    enabled,
    activeCode,
    codeDraft,
    busy,
    onToggle,
    onRegenerate,
    onCodeDraftChange,
    onApplyCustomCode,
    onCopyCode,
  } = props;

  // The 6-digit code currently protecting the link (displayed verbatim so
  // the user can read/type it to their peer).
  const displayCode = enabled ? (activeCode ?? codeDraft) : "";

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={enabled}
          onChange={onToggle}
          disabled={busy}
          aria-label="Require an extra 6-digit code to join"
          data-testid={TESTIDS.extraCodeToggle}
          className="accent-primary focus-visible:ring-ring/50 mt-0.5 size-4 rounded-sm focus-visible:ring-1 focus-visible:outline-none disabled:opacity-50"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
            <LockIcon className="text-primary size-3.5" aria-hidden="true" />
            Require an extra code
          </span>
          <span className="text-muted-foreground leading-4">
            They will also need this 6-digit code to get in. Send it on a different channel than the
            link — anyone who sees both can pretend to be them.
          </span>
        </span>
      </label>

      {enabled && (
        <div
          className="bg-primary/5 border-primary/30 flex flex-col gap-2 rounded-md border px-3 py-2.5"
          data-slot="extra-code"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
              Extra code
            </span>
            {displayCode.length === 6 ? (
              <code
                className="text-primary text-base font-semibold tracking-[0.3em] tabular-nums"
                aria-label="Extra code"
                data-testid={TESTIDS.extraCodeValue}
              >
                {displayCode}
              </code>
            ) : (
              <span className="text-muted-foreground text-xs tabular-nums">generating…</span>
            )}
            {displayCode.length === 6 && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onCopyCode(displayCode)}
                disabled={busy}
                aria-label="Copy extra code"
              >
                <CopyIcon className="size-3" />
                Copy code
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={onRegenerate}
              disabled={busy}
              className="ml-auto"
              aria-label="Generate a different extra code"
            >
              <RefreshCwIcon className="size-3" />
              New code
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Label
              htmlFor="extra-code-input"
              className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide"
            >
              Pick your own
            </Label>
            <Input
              id="extra-code-input"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={codeDraft}
              onChange={onCodeDraftChange}
              disabled={busy}
              placeholder="6 digits"
              className={cn("h-6 w-24 font-mono text-xs tabular-nums")}
              aria-label="Choose your own extra code"
              data-testid={TESTIDS.extraCodeInput}
            />
            <Button
              variant="outline"
              size="xs"
              onClick={onApplyCustomCode}
              disabled={busy || codeDraft.length !== 6}
            >
              Use this code
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
