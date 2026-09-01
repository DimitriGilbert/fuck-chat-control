/**
 * Join conversation (responder) screen. The user pastes an invitation link
 * (or scans/picks it from a share); the controller parses the fragment and
 * runs the responder handshake.
 */
import * as React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useChatController } from "../chat/mobile-chat-provider";
import { colors } from "../ui/colors";

export interface JoinConversationScreenProps {
  readonly onJoined: () => void;
  readonly onBack: () => void;
}

export function JoinConversationScreen({
  onJoined,
  onBack,
}: JoinConversationScreenProps): React.ReactElement {
  const controller = useChatController();
  const [fragment, setFragment] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleJoin = React.useCallback(async () => {
    const trimmed = fragment.trim();
    if (trimmed.length === 0) {
      setError("Paste an invitation link first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await controller.joinConversation(trimmed);
      onJoined();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [controller, fragment, onJoined]);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.title}>Join conversation</Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={styles.body}>
        <Text style={styles.label}>Invitation link</Text>
        <TextInput
          style={styles.input}
          value={fragment}
          onChangeText={setFragment}
          placeholder="Paste the invitation link you received"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        <Pressable
          style={[styles.primaryButton, busy ? styles.buttonDisabled : null]}
          onPress={handleJoin}
          disabled={busy}
        >
          <Text style={styles.primaryButtonText}>{busy ? "Joining…" : "Join"}</Text>
        </Pressable>
        {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      </View>
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
  label: { color: colors.textMuted, fontSize: 12, fontWeight: "600", textTransform: "uppercase" },
  input: {
    backgroundColor: colors.surface,
    color: colors.text,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 80,
    fontSize: 14,
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
