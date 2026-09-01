/**
 * Home / empty state. Shows the two entry points the v1 UI exposes: start a
 * fresh conversation (initiator) or join an existing one (responder). Lists
 * persisted conversations below.
 *
 * R8/F2 fail-closed gating: both entry points target screens that call
 * `useChatController()` during render, which throws while the provider is
 * still constructing (`!ready`) or after its fail-closed catch set
 * `state.error` with no controller. The buttons are therefore disabled (and
 * the error surfaced) until the provider is ready and error-free.
 */
import * as React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useChat } from "../chat/mobile-chat-provider";
import { colors } from "../ui/colors";

export interface HomeScreenProps {
  readonly onStart: () => void;
  readonly onJoin: () => void;
  readonly onOpen: (conversationIdHex: string) => void;
}

/** ConversationId is a branded Uint8Array; hex-encode for display + keys. */
function toHex(id: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < id.length; i++) {
    hex += id[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export function HomeScreen({ onStart, onJoin, onOpen }: HomeScreenProps): React.ReactElement {
  const { state, ready } = useChat();
  const conversations = state.conversations;
  // R8/F2: gate the chat-surface entry points while the provider is not
  // usable. `state.error` is rendered below instead of the silent dead-end
  // the fail-closed path used to leave.
  const entryBlocked = !ready || state.error !== null;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>fck-chat-control</Text>
      <Text style={styles.subtitle}>
        Peer-to-peer, at-rest-encrypted chat. Safety-number-only auth for v1.
      </Text>

      <Pressable
        style={[styles.primaryButton, entryBlocked ? styles.entryDisabled : null]}
        onPress={onStart}
        disabled={entryBlocked}
      >
        <Text style={styles.primaryButtonText}>Start a conversation</Text>
      </Pressable>
      <Pressable
        style={[styles.secondaryButton, entryBlocked ? styles.entryDisabled : null]}
        onPress={onJoin}
        disabled={entryBlocked}
      >
        <Text style={styles.secondaryButtonText}>Join with invitation</Text>
      </Pressable>
      {state.error !== null ? <Text style={styles.error}>{state.error}</Text> : null}
      {!ready && state.error === null ? (
        <Text style={styles.startingUp}>Preparing secure storage…</Text>
      ) : null}

      {conversations.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Previous conversations</Text>
          {conversations.map((c) => {
            const hex = toHex(c.id);
            return (
              <Pressable key={hex} style={styles.row} onPress={() => onOpen(hex)}>
                <Text style={styles.rowTitle}>{hex.slice(0, 8)}</Text>
                {c.peer !== null ? (
                  <Text style={styles.rowSub}>{c.peer.fingerprint.slice(0, 16)}…</Text>
                ) : (
                  <Text style={styles.rowSub}>No peer yet</Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, gap: 12 },
  title: { color: colors.text, fontSize: 28, fontWeight: "700", marginTop: 12 },
  subtitle: { color: colors.textMuted, fontSize: 14, marginBottom: 8 },
  primaryButton: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  primaryButtonText: { color: colors.accentText, fontSize: 16, fontWeight: "600" },
  secondaryButton: {
    backgroundColor: colors.surface,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryButtonText: { color: colors.text, fontSize: 16, fontWeight: "500" },
  section: { marginTop: 24, gap: 8 },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  row: {
    backgroundColor: colors.surface,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  rowSub: { color: colors.textMuted, fontSize: 12 },
  entryDisabled: { opacity: 0.5 },
  error: { color: colors.danger, fontSize: 13 },
  startingUp: { color: colors.textMuted, fontSize: 13 },
});
