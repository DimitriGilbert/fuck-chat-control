import type { Browser, BrowserContext, Page } from "@playwright/test";

/**
 * Connection-state labels rendered in the status pill (see
 * src/features/chat/ui/chat-status.ts). Centralized so the e2e selectors stay
 * in sync with a single source of truth.
 */
export const CONNECTION_STATE_TEXT = {
  idle: "Idle",
  waiting: "Waiting for peer",
  signaling: "Signaling",
  handshaking: "Handshaking",
  verifying: "Verifying",
  connected: "Connected",
  disconnected: "Disconnected",
} as const;

/**
 * A two-peer P2P harness: two isolated browser contexts (separate
 * localStorage / cookies / identity) that establish a real WebRTC session
 * through the in-process broker. Caller is responsible for `close()`.
 *
 * Returns both pages plus the invitation link, so individual tests can drive
 * the session (send messages, open settings, leave) without re-establishing it
 * every time.
 */
export interface PeerPair {
  readonly pageA: Page;
  readonly pageB: Page;
  readonly contextA: BrowserContext;
  readonly contextB: BrowserContext;
  readonly invitation: string;
  /**
   * The 6-digit PAKE code when {@link establishPeerPair} was called with
   * `coded: true`; null otherwise. Test specs assert against this to confirm
   * the link carried a code and to drive a wrong-code negative case by
   * mutating the URL before pageB opens it.
   */
  readonly pakeCode: string | null;
  close(): Promise<void>;
}

export interface EstablishPeerPairOptions {
  /**
   * When true, pageA's invitation is generated with a 6-digit PAKE code so
   * the responder (pageB) runs SPAKE2 against it. The invitation link carries
   * `~<code>` in the URL hash; the code itself is exposed on the returned
   * {@link PeerPair.pakeCode} so the test can assert against it.
   */
  readonly coded?: boolean;
}

export async function establishPeerPair(
  browser: Browser,
  options?: EstablishPeerPairOptions,
): Promise<PeerPair> {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  // Wait for the start button to be enabled (controller ready) on A, then
  // start a conversation and read the generated invitation link. Scope to the
  // sidebar (<aside> / complementary): the empty state also exposes a Start
  // affordance on all viewports, so the sidebar's button is the canonical one.
  await pageA.goto("/");
  await pageA
    .getByRole("complementary")
    .getByRole("button", { name: /Start a conversation/ })
    .click();

  let pakeCode: string | null = null;
  if (options?.coded === true) {
    // Toggle the "Protect with a 6-digit code (PAKE)" checkbox in the
    // InvitationBanner. The banner rewrites the invitation link in place to
    // carry `~<code>`.
    await pageA
      .getByRole("checkbox", {
        name: /Protect this conversation with a 6-digit PAKE code/,
      })
      .check();
    // The banner's "PAKE code" panel renders the 6-digit code in a <code>
    // element labeled exactly "PAKE code" (the surrounding Copy / Regenerate /
    // Custom buttons all have distinct aria-labels, but Playwright's
    // substring match would otherwise pick them up). Use exact to scope.
    await pageA.getByLabel("PAKE code", { exact: true }).waitFor({ state: "visible" });
    pakeCode = (await pageA.getByLabel("PAKE code", { exact: true }).textContent()) ?? null;
  }

  const invitation = (await pageA.getByLabel("Invitation link").inputValue()) as string;

  // B opens the invitation URL fresh (its own context; the hash never reaches
  // the server). This is the real user flow: the peer pastes the link.
  await pageB.goto(invitation);

  return {
    pageA,
    pageB,
    contextA,
    contextB,
    invitation,
    pakeCode,
    async close(): Promise<void> {
      await contextA.close();
      await contextB.close();
    },
  };
}

/**
 * Extract the bare 32-hex invitation fragment from a full invitation URL
 * (`http://host/#<hex>` -> the hex). Useful for assertions that the link is
 * well-formed without coupling to the host.
 */
export function invitationHex(url: string): string {
  const hashIndex = url.lastIndexOf("#");
  if (hashIndex < 0) return "";
  const bare = url.slice(hashIndex + 1);
  // Strip a `~code` suffix if present (PAKE-coded invitations).
  const tildeIdx = bare.indexOf("~");
  return tildeIdx >= 0 ? bare.slice(0, tildeIdx) : bare;
}

/**
 * Replace the PAKE code in an invitation URL with a different code. Used by
 * the wrong-code negative case to drive a guaranteed mismatch without
 * re-running the initiator flow.
 */
export function withPakeCode(invitation: string, code: string): string {
  const hashIndex = invitation.lastIndexOf("#");
  if (hashIndex < 0) return invitation;
  const bare = invitation.slice(hashIndex + 1);
  const tildeIdx = bare.indexOf("~");
  const hexPart = tildeIdx >= 0 ? bare.slice(0, tildeIdx) : bare;
  return `${invitation.slice(0, hashIndex + 1)}${hexPart}~${code}`;
}
