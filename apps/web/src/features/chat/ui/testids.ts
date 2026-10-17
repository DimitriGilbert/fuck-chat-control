/**
 * Stable `data-testid` anchors for the affordances e2e and unit tests couple
 * to. Centralized so user-facing copy can change freely without breaking
 * selectors — the tests locate these, not button labels.
 *
 * Keep these stable: changing a value is a breaking change for
 * tests/e2e/_helpers.ts and the Playwright specs.
 */
export const TESTIDS = {
  /** Sidebar's "Start a conversation" CTA (desktop rail). */
  startConversation: "start-conversation",
  /** Mobile home's "Start a conversation" CTA (list-first view). */
  startConversationMobile: "start-conversation-mobile",
  /** Empty state's "Start a conversation" CTA. */
  startConversationEmpty: "start-conversation-empty",
  /** The extra-code (formerly PAKE) checkbox in the invitation panel. */
  extraCodeToggle: "extra-code-toggle",
  /** The custom extra-code text input. */
  extraCodeInput: "extra-code-input",
  /** The rendered 6-digit extra code. */
  extraCodeValue: "extra-code-value",
  /** The read-only invitation link input. */
  invitationLinkInput: "invitation-link-input",
  /** The connection-state pill's text in the chat header. */
  connectionState: "connection-state",
  /** The chat-header "verify it's really them" affordance. */
  verifyPeer: "verify-peer",
  /** The mobile back-to-list button on the pushed-over chat pane. */
  backToConversations: "back-to-conversations",
  /** The mobile conversation list (list-first home). */
  conversationList: "conversation-list",
} as const;

export type TestId = (typeof TESTIDS)[keyof typeof TESTIDS];
