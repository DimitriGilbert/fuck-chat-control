/**
 * Start conversation (initiator) screen. Calls
 * `controller.startConversation()` to produce a safety-number-only invitation
 * link the initiator shares out-of-band.
 *
 * Mobile v1 is SAFETY-NUMBER-ONLY BY DESIGN. The PAKE/SPAKE2-coded invitation
 * mode is desktop/web-only: its wasm loader is dead on React Native because
 * (a) the mobile provider never calls `setSpake2ModuleUrl`, and (b)
 * `apps/mobile/metro.config.js` blockLists the `packages/chat-runtime/wasm/
 * spake2/pkg/` artifacts so the dynamic `import(specifier)` inside
 * `packages/chat-runtime/src/crypto/pake.ts` (loadWasm, ~line 124) is never
 * bundled. The RN carve-out is documented at
 * `packages/chat-runtime/src/crypto/pake.ts:133-135` (React Native v1 is
 * safety-number-only and NEVER reaches the PAKE code path). Accordingly this
 * screen exposes NO coded-invitation toggle, NO PAKE-code input/display, and
 * handleStart never passes a `code` to `startConversation`.
 *
 * Threat-model note (R7/F6): safety-number-only invitations rely on the user
 * manually comparing safety numbers AFTER the handshake — a weaker guarantee
 * than a PAKE-coded invitation (which authenticates the handshake
 * cryptographically), but the only mode the RN runtime can currently stand up.
 */
import * as React from "react";
import { Pressable, Share, StyleSheet, Text, TextInput, View } from "react-native";

import { useChatController, useChatState } from "../chat/mobile-chat-provider";
import { colors } from "../ui/colors";

export interface StartConversationScreenProps {
  readonly onStarted: () => void;
  readonly onBack: () => void;
}

export function StartConversationScreen({
  onStarted,
  onBack,
}: StartConversationScreenProps): React.ReactElement {
  const controller = useChatController();
  const state = useChatState();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const invitation = state.invitation;

  const handleStart = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await controller.startConversation();
      onStarted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [controller, onStarted]);

  const handleShare = React.useCallback(async () => {
    if (invitation === null) return;
    // CRITICAL-B / L2: derive the shareable link from the `#` fragment
    // separator rather than splitting on `~`. An invitation is shaped
    // `${baseUrl}#${hex32}[~${code}]` (see invitation.ts:formatInvitation /
    // formatCodedInvitation), where hex32 is exactly 32 hex chars (= 16
    // conversation-id bytes × 2, per `conversationIdToHex`). Keep
    // `baseUrl#<32-hex>` and discard any `~code` tail so the SPAKE2 secret —
    // if one is ever reintroduced on this platform — never travels inside the
    // shared link. Defense-in-depth: mobile v1 produces safety-number-only
    // invitations (no `~code` tail) by construction, but anchoring on `#`
    // keeps Share correct for any future reintroduction of the coded path.
    const hashIdx = invitation.indexOf("#");
    // `32` is CONVERSATION_ID_BYTES * 2 from
    // packages/chat-runtime/src/protocol/limits.ts; see conversationIdToHex.
    const linkOnly = hashIdx === -1 ? invitation : invitation.slice(0, hashIdx + 1 + 32);
    try {
      await Share.share(
        { message: linkOnly, title: "Share invitation" },
        { dialogTitle: "Share invitation" },
      );
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? `Could not open the share sheet: ${err.message}`
          : "Could not open the share sheet.",
      );
    }
  }, [invitation]);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.title}>Start a conversation</Text>
        <View style={styles.headerSpacer} />
      </View>

      {invitation === null ? (
        <View style={styles.body}>
          <Text style={styles.text}>
            A fresh invitation link will be generated. Share it out-of-band with the person you want
            to chat with.
          </Text>
          <Pressable
            style={[styles.primaryButton, busy ? styles.buttonDisabled : null]}
            onPress={handleStart}
            disabled={busy}
          >
            <Text style={styles.primaryButtonText}>
              {busy ? "Generating…" : "Generate invitation"}
            </Text>
          </Pressable>
          {error !== null ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      ) : (
        <View style={styles.body}>
          <Text style={styles.label}>Invitation link</Text>
          <TextInput
            style={styles.invitationBox}
            value={invitation}
            multiline
            selectTextOnFocus
            editable={false}
          />
          <Pressable style={styles.primaryButton} onPress={handleShare}>
            <Text style={styles.primaryButtonText}>Share link</Text>
          </Pressable>
          <Text style={styles.text}>
            Waiting for the peer to join. The chat screen opens automatically once the handshake
            completes.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backText: { color: colors.accent, fontSize: 16 },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  headerSpacer: { width: 40 },
  body: { padding: 20, gap: 16, flex: 1 },
  text: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  label: { color: colors.textMuted, fontSize: 12, fontWeight: "600", textTransform: "uppercase" },
  invitationBox: {
    backgroundColor: colors.surface,
    color: colors.text,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 80,
    fontSize: 13,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  primaryButtonText: { color: colors.accentText, fontSize: 16, fontWeight: "600" },
  buttonDisabled: { opacity: 0.5 },
  error: { color: colors.danger, fontSize: 13 },
});
