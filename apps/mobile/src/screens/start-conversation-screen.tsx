/**
 * Start conversation (initiator) screen. Calls
 * `controller.startConversation()` (safety-number-only by default), or — when
 * the user opts in via the toggle — `startConversation({ code })` for the
 * cryptographically-stronger PAKE-coded variant. In both modes the broker
 * returns an invitation link the initiator shares out-of-band.
 *
 * Threat-model note (R7/F6): a PAKE-coded invitation authenticates the
 * handshake cryptographically against a shared 6-digit secret, so an attacker
 * who controls the broker cannot silently MITM the exchange. Safety-number-
 * only invitations rely on the user manually comparing safety numbers AFTER
 * the handshake — a weaker guarantee if the comparison is skipped.
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
  // PAKE-coded invitation toggle. Off by default preserves the v1
  // safety-number-only behavior. When on, handleStart pulls a CSPRNG-backed
  // 6-digit code from the controller and passes it to startConversation,
  // producing an invitation whose fragment carries `~<code>`. The code is
  // then shown below the invitation box so it can be shared over a side
  // channel alongside (NOT inside) the link.
  const [requireCode, setRequireCode] = React.useState(false);
  const [pakeCode, setPakeCode] = React.useState<string | null>(null);
  const invitation = state.invitation;

  const handleStart = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (requireCode) {
        const code = controller.generatePakeCode();
        setPakeCode(code);
        await controller.startConversation({ code });
      } else {
        setPakeCode(null);
        await controller.startConversation();
      }
      onStarted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [controller, onStarted, requireCode]);

  const handleShare = React.useCallback(async () => {
    if (invitation === null) return;
    // CRITICAL-B: strip the `~<PAKE-code>` tail before sharing. A coded
    // invitation is `${baseUrl}#${hex32}~${code}`; the `~code` suffix is the
    // SPAKE2 secret and MUST travel over a side channel, NOT inside the same
    // payload as the link (see invitation.ts:formatCodedInvitation). The code
    // is already rendered separately below with its own share guidance.
    const linkOnly = invitation.split("~")[0];
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
          {/*
            PAKE-coded invitation toggle (R7/F6). Opting in upgrades the
            handshake from safety-number-only to cryptographic authentication
            against a shared 6-digit secret — see the file-level docstring.
          */}
          <Pressable style={styles.toggleRow} onPress={() => setRequireCode((prev) => !prev)}>
            <View style={[styles.checkbox, requireCode ? styles.checkboxChecked : null]} />
            <View style={styles.toggleText}>
              <Text style={styles.toggleTitle}>Require PAKE code (recommended)</Text>
              <Text style={styles.toggleSub}>
                Generates a 6-digit code the peer must enter. Cryptographically blocks a malicious
                broker from intercepting the handshake.
              </Text>
            </View>
          </Pressable>
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
          {pakeCode !== null ? (
            <View style={styles.codeBlock}>
              <Text style={styles.label}>PAKE code (REQUIRED by peer)</Text>
              <Text style={styles.codeValue}>{pakeCode}</Text>
              <Text style={styles.codeHelp}>
                Share this 6-digit code over a separate channel (voice, different app). The peer
                cannot join without it.
              </Text>
            </View>
          ) : null}
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
  toggleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: colors.surface,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  toggleText: { flex: 1, gap: 4 },
  toggleTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  toggleSub: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  codeBlock: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  codeValue: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: 4,
  },
  codeHelp: { color: colors.textMuted, fontSize: 12, lineHeight: 16 },
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
