/**
 * Start conversation (initiator) screen. Calls
 * `controller.startConversation()` (safety-number-only — no PAKE code), then
 * surfaces the invitation link the broker returns so the user can share it
 * out-of-band.
 */
import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Sharing from 'expo-sharing';

import { useChatController, useChatState } from '../chat/mobile-chat-provider';
import { colors } from '../ui/colors';

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
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(invitation, {
        mimeType: 'text/plain',
        dialogTitle: 'Share invitation',
      });
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
            A fresh invitation link will be generated. Share it out-of-band with
            the person you want to chat with. Authentication is safety-number-only
            for v1.
          </Text>
          <Pressable
            style={[styles.primaryButton, busy ? styles.buttonDisabled : null]}
            onPress={handleStart}
            disabled={busy}
          >
            <Text style={styles.primaryButtonText}>
              {busy ? 'Generating…' : 'Generate invitation'}
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
            Waiting for the peer to join. The chat screen opens automatically
            once the handshake completes.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backText: { color: colors.accent, fontSize: 16 },
  title: { color: colors.text, fontSize: 18, fontWeight: '600' },
  headerSpacer: { width: 40 },
  body: { padding: 20, gap: 16, flex: 1 },
  text: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  label: { color: colors.textMuted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
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
    alignItems: 'center',
  },
  primaryButtonText: { color: colors.accentText, fontSize: 16, fontWeight: '600' },
  buttonDisabled: { opacity: 0.5 },
  error: { color: colors.danger, fontSize: 13 },
});
