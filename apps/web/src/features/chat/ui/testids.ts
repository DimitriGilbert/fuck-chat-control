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
  /** Sidebar "New group" affordance — opens the create-group dialog. */
  newGroup: "new-group",
  /** The optional local group-name input in the create-group dialog. */
  groupNameInput: "group-name-input",
  /** The optional own-display-name input in the create-group dialog. */
  groupDisplayNameInput: "group-display-name-input",
  /** The optional 6-digit extra-code input in the create-group dialog. */
  groupCodeInput: "group-code-input",
  /** The "Create group" submit action in the create-group dialog. */
  createGroup: "create-group",
  /** A group row in the unified session list (row carries data-group-id). */
  groupEntry: "group-entry",
  /**
   * The join-mode decision point (protocol-v2 §8): invitation links carry no
   * mode bit, so the pending-join dialog offers "join as 1:1" and
   * "join as group" actions.
   */
  joinAsPair: "join-as-pair",
  joinAsGroup: "join-as-group",
  /** The main-pane group surface (Phase 7a minimal view). */
  groupView: "group-view",
  /** The group header's members-button (opens the members sheet). */
  groupMembers: "group-members",
  /** The members sheet's content region. */
  groupMembersPanel: "group-members-panel",
  /** One member row inside the members sheet (carries data-member-key). */
  groupMemberRow: "group-member-row",
  /** The author-only per-member remove affordance inside the sheet. */
  groupMemberRemove: "group-member-remove",
  /** The confirm action inside the remove-member alert dialog. */
  groupMemberRemoveConfirm: "group-member-remove-confirm",
  /** The group header's "verify this group" affordance. */
  verifyGroup: "verify-group",
  /** The group safety-number dialog content. */
  groupSafetyDialog: "group-safety-dialog",
  /** The group safety dialog's confirm ("The numbers match") action. */
  groupSafetyConfirm: "group-safety-confirm",
} as const;

export type TestId = (typeof TESTIDS)[keyof typeof TESTIDS];
