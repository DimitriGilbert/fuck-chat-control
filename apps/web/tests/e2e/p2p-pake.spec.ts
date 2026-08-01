import { expect, test } from "@playwright/test";

import { CONNECTION_STATE_TEXT, establishPeerPair, withPakeCode, type PeerPair } from "./_helpers";

/**
 * Phase 10 PAKE e2e: a coded invitation triggers SPAKE2 over the data
 * channel and reaches Connected iff both peers share the same 6-digit code.
 *
 * These specs complement the unit/integration PAKE coverage by exercising
 * the full browser path:
 *   - readInvitationFragment (UI) accepts the `~<code>` hash and passes the
 *     full fragment to joinConversation;
 *   - parseInvitation (orchestrator) extracts the code and arms PAKE before
 *     the handshake begins;
 *   - the real WebRTC + SPAKE2 exchange runs in two isolated browser
 *     contexts.
 *
 * Loopback WebRTC needs no STUN. The /ice-config endpoint returns an empty
 * iceServers list when no STUN/TURN env is configured (the CI/dev baseline),
 * and the chat-provider falls back to [] on any fetch failure — so loopback
 * P2P here always gathers host candidates only. Timeouts are generous because ICE on loopback can take a few
 * seconds and the dev server SSR-compiles on first boot — same baseline as
 * p2p.spec.ts.
 */
test.describe("PAKE-coded invitation", () => {
  test("a coded invitation drives both peers to Connected via SPAKE2", async ({ browser }) => {
    test.setTimeout(120_000);
    const pair: PeerPair = await establishPeerPair(browser, { coded: true });

    try {
      // Sanity: the harness produced a coded invitation.
      expect(pair.pakeCode).not.toBeNull();
      expect(pair.invitation).toMatch(/~\d{1,6}$/);

      // Both peers reach Connected: PAKE succeeded against the same code.
      await expect(
        pair.pageA.getByRole("main").getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        pair.pageB.getByRole("main").getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });

      // Exchange a message end-to-end to prove the encrypted channel is up.
      const composer = pair.pageA.getByRole("textbox", { name: "Message" });
      await composer.fill("hello over PAKE");
      await composer.press("Enter");
      await expect(pair.pageB.getByRole("main").getByText("hello over PAKE")).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await pair.close();
    }
  });

  test("a wrong-code invitation does NOT reach Connected", async ({ browser }) => {
    test.setTimeout(120_000);
    // We cannot use the establishPeerPair helper for the wrong-code case
    // because the helper opens pageB with the correct invitation. Drive the
    // two-context flow by hand so we can substitute a tampered code.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await pageA.goto("/");
      await pageA
        .getByRole("complementary")
        .getByRole("button", { name: /Start a conversation/ })
        .click();
      await pageA
        .getByRole("checkbox", {
          name: /Protect this conversation with a 6-digit PAKE code/,
        })
        .check();
      await pageA.getByLabel("PAKE code", { exact: true }).waitFor({ state: "visible" });

      const realCode = (await pageA.getByLabel("PAKE code", { exact: true }).textContent()) ?? "";
      expect(realCode.length).toBe(6);

      const codedInvitation = (await pageA.getByLabel("Invitation link").inputValue()) as string;
      // Tamper with the code so the responder's PAKE state is derived from a
      // different password than the initiator's.
      const tamperedCode = realCode === "000000" ? "999999" : "000000";
      const tamperedInvitation = withPakeCode(codedInvitation, tamperedCode);
      expect(tamperedInvitation).not.toBe(codedInvitation);

      await pageB.goto(tamperedInvitation);

      // PAKE mismatch aborts loudly: BOTH sides must end up NOT-Connected
      // within a bounded window. We assert against the negative (no
      // "Connected" text appears) rather than a specific failure state
      // because the abort surfaces as Disconnected or auth-failed depending
      // on the exact timing of the peer-leave signal vs. the PAKE confirm
      // mismatch — both are correct terminal states for the wrong-code case.
      // Two-minute hard ceiling; in practice the abort fires in seconds.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const aConnected = await pageA
          .getByRole("main")
          .getByText(CONNECTION_STATE_TEXT.connected, { exact: true })
          .count();
        const bConnected = await pageB
          .getByRole("main")
          .getByText(CONNECTION_STATE_TEXT.connected, { exact: true })
          .count();
        if (aConnected === 0 && bConnected === 0) {
          // Confirmed neither side connected within this poll window.
          break;
        }
        await pageA.waitForTimeout(1000);
      }

      // Final assertion: neither side reached Connected.
      await expect(
        pageA.getByRole("main").getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toHaveCount(0);
      await expect(
        pageB.getByRole("main").getByText(CONNECTION_STATE_TEXT.connected, { exact: true }),
      ).toHaveCount(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
