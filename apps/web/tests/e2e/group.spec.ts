import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { invitationLinkInput, TID } from "./_helpers";

/**
 * Protocol-v2 group e2e: three isolated browser contexts (separate
 * localStorage / identity) form a real 3-member mesh through the in-process
 * broker — the author creates a PAKE group via the new-group dialog, two
 * members join through the shared invitation link's join-mode chooser, and
 * every member ends up with a pairwise link to every other member.
 *
 * Asserts the group contract end to end: full-mesh connectivity (the "k/n
 * connected" pill converges), attributed fan-out messaging (each sender's
 * text reaches the other two members under the right sender caption), and
 * author-admin removal (the kicked member's session self-ejects while the
 * survivors re-converge on the smaller member list).
 *
 * Loopback WebRTC needs no STUN, same as the 1:1 specs. The mesh runs three
 * pairwise handshakes each with the SPAKE2 rounds, so timeouts are even more
 * generous than p2p-pake.spec.ts.
 */

/** The active group's main-pane surface. */
function groupView(page: Page): Locator {
  return page.getByTestId(TID.groupView);
}

/** The composer textarea inside the group view (aria-label "Group message"). */
function groupComposer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Group message" });
}

/** The transcript row containing `text` (one message-content slot). */
function groupMessage(page: Page, text: string): Locator {
  return groupView(page).locator('[data-slot="message-content"]', { hasText: text });
}

/** Type into the group composer and send with Enter. */
async function sendGroupText(page: Page, text: string): Promise<void> {
  const composer = groupComposer(page);
  await composer.fill(text);
  await composer.press("Enter");
}

test.describe("three-member group", () => {
  test("members join a PAKE group, exchange attributed messages, and a removed member is excluded", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const contextC = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();

    try {
      // --- Author creates a PAKE group via the new-group dialog. The
      // sidebar is mounted twice (desktop rail + mobile list-first home) so
      // the new-group testid resolves twice; both open the same dialog and
      // the desktop instance is first in DOM order.
      await pageA.goto("/");
      await pageA.getByTestId(TID.newGroup).first().click();
      await pageA.getByTestId(TID.groupNameInput).fill("weekend plans");
      // The announced member name — later proves sender attribution, since
      // the author's received messages render "Alice" instead of a key
      // prefix.
      await pageA.getByTestId(TID.groupDisplayNameInput).fill("Alice");
      // "Require an extra code" mints a CSPRNG 6-digit code into
      // group-code-input; the invitation link then carries `~<code>` and
      // every pairwise handshake runs SPAKE2 against it.
      await pageA.getByRole("checkbox", { name: "Require an extra 6-digit code to join" }).check();
      const createButton = pageA.getByTestId(TID.createGroup);
      // PAKE groups stay disabled until the SPAKE2 wasm is ready — cold wasm
      // init under Playwright has been observed to exceed 20s, so give the
      // button the generous end of the budget.
      await expect(createButton).toBeEnabled({ timeout: 120_000 });
      await createButton.click();

      await expect(groupView(pageA)).toBeVisible({ timeout: 20_000 });
      const invitation = (await invitationLinkInput(pageA).inputValue()) as string;
      // The PAKE group link carries the 6-digit code in the fragment.
      expect(invitation).toMatch(/#[0-9a-f]{32}~\d{6}$/);

      // --- Both members open the link and choose "Join as group" — the
      // fragment bytes carry no mode bit (protocol-v2 §8), so the chooser
      // dialog is the real user path. Joins are staggered: B joins and its
      // link converges before C arrives, matching how real members trickle
      // in (and keeping the mesh deterministic under test).
      await pageB.goto(invitation);
      await pageB.getByTestId(TID.joinAsGroup).click();
      await expect(groupView(pageB)).toBeVisible({ timeout: 20_000 });

      // With two members seated, each side's pill reads "1/1 connected".
      await expect(groupView(pageA).getByText("1/1 connected", { exact: true })).toBeVisible({
        timeout: 150_000,
      });
      await expect(groupView(pageB).getByText("1/1 connected", { exact: true })).toBeVisible({
        timeout: 150_000,
      });

      await pageC.goto(invitation);
      await pageC.getByTestId(TID.joinAsGroup).click();
      await expect(groupView(pageC)).toBeVisible({ timeout: 20_000 });

      // --- Membership converges: all three pages adopt the author's signed
      // 3-member list (the members-button badge is the live count).
      for (const page of [pageA, pageB, pageC]) {
        await expect(page.getByTestId(TID.groupMembers)).toContainText("3", {
          timeout: 150_000,
        });
      }

      // --- Full mesh: each member holds a Connected pairwise link to both
      // others, so the header pill reads "2/2 connected" everywhere.
      for (const page of [pageA, pageB, pageC]) {
        await expect(groupView(page).getByText("2/2 connected", { exact: true })).toBeVisible({
          timeout: 150_000,
        });
      }

      // --- Attributed fan-out: a message from each member reaches the OTHER
      // two with the sender's identity attached. The author's announced
      // display name labels its messages; unnamed members fall back to the
      // 8-hex identity-key prefix (same rule as the members sheet).
      await sendGroupText(pageA, "hello from the author");
      for (const page of [pageB, pageC]) {
        const row = groupMessage(page, "hello from the author");
        await expect(row).toBeVisible({ timeout: 15_000 });
        await expect(row.locator("span").first()).toHaveText("Alice", { timeout: 10_000 });
      }

      await sendGroupText(pageB, "member-two says hi");
      for (const page of [pageA, pageC]) {
        const row = groupMessage(page, "member-two says hi");
        await expect(row).toBeVisible({ timeout: 15_000 });
        await expect(row.locator("span").first()).toHaveText(/^[0-9a-f]{8}…$/, {
          timeout: 10_000,
        });
      }

      await sendGroupText(pageC, "member-three says hi");
      for (const page of [pageA, pageB]) {
        const row = groupMessage(page, "member-three says hi");
        await expect(row).toBeVisible({ timeout: 15_000 });
        await expect(row.locator("span").first()).toHaveText(/^[0-9a-f]{8}…$/, {
          timeout: 10_000,
        });
      }

      // Sender attribution is per-link, not per-string: on the author, the
      // captions above member-two's and member-three's messages are two
      // DIFFERENT key prefixes.
      const captionB = await groupMessage(pageA, "member-two says hi")
        .locator("span")
        .first()
        .textContent();
      const captionC = await groupMessage(pageA, "member-three says hi")
        .locator("span")
        .first()
        .textContent();
      expect(captionB).not.toBeNull();
      expect(captionC).not.toBeNull();
      expect(captionB).not.toBe(captionC);

      // --- Author removes member C. The victim row is located by its
      // data-member-key, learned from C's own members sheet where the local
      // row carries "(you)".
      await pageC.getByTestId(TID.groupMembers).click();
      const selfRow = pageC.getByTestId(TID.groupMemberRow).filter({ hasText: "(you)" });
      await expect(selfRow).toBeVisible({ timeout: 10_000 });
      const victimHex = await selfRow.getAttribute("data-member-key");
      expect(victimHex).not.toBeNull();
      await pageC.keyboard.press("Escape");

      await pageA.getByTestId(TID.groupMembers).click();
      await expect(
        pageA.getByTestId(TID.groupMembersPanel).getByTestId(TID.groupMemberRow),
      ).toHaveCount(3, { timeout: 10_000 });
      await pageA
        .locator(`[data-member-key="${victimHex ?? ""}"]`)
        .getByTestId(TID.groupMemberRemove)
        .click();
      await pageA.getByTestId(TID.groupMemberRemoveConfirm).click();
      // Dismiss the members sheet so it does not cover the composer for the
      // post-removal send below.
      await pageA.keyboard.press("Escape");

      // The survivors adopt the epoch-bumped 2-member list: the badge drops
      // to 2 and the connectivity pill re-converges at "1/1 connected".
      await expect(pageA.getByTestId(TID.groupMembers)).toContainText("2", {
        timeout: 30_000,
      });
      await expect(pageB.getByTestId(TID.groupMembers)).toContainText("2", {
        timeout: 30_000,
      });
      await expect(groupView(pageA).getByText("1/1 connected", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(groupView(pageB).getByText("1/1 connected", { exact: true })).toBeVisible({
        timeout: 30_000,
      });

      // The removed member self-ejects: its group session ends, the group
      // view unmounts, and the group row leaves its session list.
      await expect(groupView(pageC)).toBeHidden({ timeout: 30_000 });
      await expect(pageC.getByTestId(TID.groupEntry)).toHaveCount(0);

      // The group still works for the survivors.
      await sendGroupText(pageA, "post-removal hello");
      await expect(groupMessage(pageB, "post-removal hello")).toBeVisible({ timeout: 15_000 });
    } finally {
      await contextA.close();
      await contextB.close();
      await contextC.close();
    }
  });
});
