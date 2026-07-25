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
  close(): Promise<void>;
}

export async function establishPeerPair(browser: Browser): Promise<PeerPair> {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  // Wait for the start button to be enabled (controller ready) on A, then
  // start a conversation and read the generated invitation link.
  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Start a conversation/ }).click();
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
  return hashIndex >= 0 ? url.slice(hashIndex + 1) : "";
}
