/**
 * Active conversation screen. Consumes `controller.subscribe`/`getState`:
 *
 *  - Message list (FlatList over `state.active.messages`).
 *  - Send text via `controller.sendText(id, text)`.
 *  - Send a file via `expo-document-picker`; the picked file's bytes are read
 *    into a `Uint8Array` and passed to `controller.sendFile(id, ChatFileInput)`.
 *    The DOM `File` is gone in RN — `ChatFileInput { data, name, mimeType }`
 *    is the neutral payload chat-runtime expects.
 *  - Transfer list: each incoming/outgoing file is surfaced as a read-only
 *    chip showing direction · name · mimeType · size · status. The bytes are
 *    fetched on demand via `controller.getReceivedFile(id, transferId)`, but
 *    `expo-sharing` needs a `file://` URI and the bytes currently live in
 *    memory, so the save/share action (and the tap handler) are deferred to a
 *    later phase that wires up `expo-file-system`.
 *  - Safety number display + verify toggle.
 */
import * as React from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { getInfoAsync } from "expo-file-system/legacy";
import { MAX_INCOMPLETE_TRANSFER_BYTES } from "@fuck-eu-chat-control/chat-runtime/protocol/limits";
import type { ConversationMessage } from "@fuck-eu-chat-control/chat-runtime/store";
import type { ChatFileInput } from "@fuck-eu-chat-control/chat-runtime/runtime/types";

import { useChatController, useChatState } from "../chat/mobile-chat-provider";
import { colors } from "../ui/colors";

export interface ChatScreenProps {
  readonly onLeave: () => void;
}

interface MessageRow {
  readonly key: string;
  readonly message: ConversationMessage;
}

/**
 * Read a DocumentPicker result into the neutral `ChatFileInput` shape. The
 * picker surfaces a `uri` (a `file://` or `content://` URI); RN's `fetch` can
 * read it as bytes when ` responseType === 'arraybuffer' ` is requested on
 * some RN runtimes, but the reliable cross-platform path is `fetch(uri).then(r
 * => r.arrayBuffer())` (Hermes + RN's fetch supports file:// reads on both
 * platforms).
 *
 * Contract:
 *  - User cancels the picker → returns `null` (silent no-op).
 *  - File is too large, or its size cannot be determined → throws. A null
 *    return would silently drop the user's tap; throwing surfaces the cause
 *    via the caller's `setError`.
 *
 * Pre-flight size check: the runtime's
 * {@link MAX_INCOMPLETE_TRANSFER_BYTES} cap (64 MiB) otherwise runs only inside
 * `FrameSender.sendFile` AFTER the bytes are already resident in JS heap, so a
 * multi-GB pick would OOM before the cap could refuse. We therefore resolve
 * the size BEFORE the `arrayBuffer()` call — preferring `asset.size` (populated
 * by the picker on iOS and most Android `file://` URIs), and falling back to
 * `expo-file-system/legacy.getInfoAsync` for Android `content://` URIs where
 * the picker leaves `size` undefined. If the size still cannot be determined
 * (`getInfoAsync` returns `exists:false` or no `size`) the file is treated as
 * too large rather than read blindly.
 */
async function readPickedFileToChatInput(
  result: DocumentPicker.DocumentPickerResult,
): Promise<ChatFileInput | null> {
  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (asset === undefined) return null;

  const size = await resolvePickedFileSize(asset);
  if (size > MAX_INCOMPLETE_TRANSFER_BYTES) {
    const mib = MAX_INCOMPLETE_TRANSFER_BYTES / (1024 * 1024);
    throw new Error(`File exceeds ${mib} MiB transfer limit`);
  }

  const response = await fetch(asset.uri);
  const buffer = await response.arrayBuffer();
  return {
    data: new Uint8Array(buffer),
    name: asset.name ?? "file.bin",
    mimeType: asset.mimeType ?? "application/octet-stream",
  };
}

/**
 * Resolve a picked asset's byte size BEFORE any `arrayBuffer()` read.
 * `asset.size` is populated by the picker on iOS and most Android `file://`
 * URIs but is frequently undefined on Android `content://` URIs; in that case
 * stat via `expo-file-system/legacy.getInfoAsync` (the SDK 57 main entry's
 * `getInfoAsync` is a throwing deprecation shim — the working API lives under
 * `/legacy`). Throws if the size cannot be determined so the caller surfaces a
 * user-visible error instead of no-opping.
 */
async function resolvePickedFileSize(asset: DocumentPicker.DocumentPickerAsset): Promise<number> {
  if (asset.size !== undefined) return asset.size;
  const info = await getInfoAsync(asset.uri);
  if (!info.exists) {
    throw new Error("Picked file does not exist or its size is unavailable");
  }
  return info.size;
}

/**
 * Compact byte formatter for the transfer chip: 0, 1.2 KB, 3.4 MB, 1.1 GB.
 * Renders at most one decimal place and drops it for whole units (e.g. 4 MB).
 * SI units (1000-base) match how the framing layer reports `size` (raw byte
 * count from the manifest, no KiB rounding).
 */
function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1000;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unitIndex]}`;
}

export function ChatScreen({ onLeave }: ChatScreenProps): React.ReactElement {
  const controller = useChatController();
  const state = useChatState();
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const active = state.active;
  const conversationId = active?.id ?? null;

  const messages: readonly ConversationMessage[] = active?.messages ?? [];
  const rows: readonly MessageRow[] = React.useMemo(
    () => messages.map((m, i) => ({ key: `${m.timestamp}-${i}`, message: m })),
    [messages],
  );

  const handleSendText = React.useCallback(async () => {
    if (conversationId === null) return;
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    setError(null);
    try {
      await controller.sendText(conversationId, text);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [controller, conversationId, draft]);

  const handleSendFile = React.useCallback(async () => {
    if (conversationId === null) return;
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({});
      const input = await readPickedFileToChatInput(result);
      if (input === null) return;
      await controller.sendFile(conversationId, input);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [controller, conversationId]);

  const handleVerify = React.useCallback(() => {
    if (conversationId === null) return;
    controller.markSafetyNumberVerified(conversationId);
  }, [controller, conversationId]);

  // R8/F1: Leave must tear down the live session (controller.leave() clears
  // activeConversationId and closes the signaling WebSocket + peer
  // connection) BEFORE the route change — matching the web handleLeave in
  // apps/web/src/features/chat/ui/chat-view.tsx. Routing home first would
  // strand a live data channel with no UI path back to it.
  const handleLeave = React.useCallback(() => {
    controller.leave();
    onLeave();
  }, [controller, onLeave]);

  if (active === null) {
    return (
      <View style={styles.screen}>
        <Text style={styles.empty}>No active conversation.</Text>
      </View>
    );
  }

  const renderItem = ({ item }: { item: MessageRow }): React.ReactElement => {
    const m = item.message;
    const isSent = m.direction === "sent";
    return (
      <View style={[styles.bubble, isSent ? styles.bubbleSent : styles.bubbleReceived]}>
        <Text style={styles.bubbleText}>{m.text}</Text>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={handleLeave}>
          <Text style={styles.backText}>Leave</Text>
        </Pressable>
        <Text style={styles.title}>{active.id.slice(0, 8)}…</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.safetyRow}>
        <Text style={styles.safetyNumber} numberOfLines={1}>
          {active.safetyNumber ?? "handshaking…"}
        </Text>
        <Pressable
          style={[
            styles.verifyButton,
            active.safetyNumberVerified ? styles.verifyButtonDone : null,
          ]}
          onPress={handleVerify}
          disabled={active.safetyNumberVerified}
        >
          <Text style={styles.verifyText}>
            {active.safetyNumberVerified ? "Verified" : "Mark verified"}
          </Text>
        </Pressable>
      </View>

      <FlatList
        style={styles.list}
        data={rows}
        renderItem={renderItem}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.listContent}
      />

      {active.transfers.length > 0 ? (
        <View style={styles.transferBar}>
          {active.transfers.map((t) => (
            <View key={t.id} style={styles.transferChip}>
              <Text style={styles.transferText}>
                {t.direction} · {t.name} · {t.mimeType} · {formatSize(t.size)} · {t.status}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.composer}>
        <Pressable style={styles.attachButton} onPress={handleSendFile}>
          <Text style={styles.attachText}>+</Text>
        </Pressable>
        <TextInput
          style={styles.textInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message"
          placeholderTextColor={colors.textMuted}
          onSubmitEditing={handleSendText}
        />
        <Pressable style={styles.sendButton} onPress={handleSendText}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </KeyboardAvoidingView>
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
  headerSpacer: { width: 50 },
  safetyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 12,
  },
  safetyNumber: { color: colors.textMuted, fontSize: 12, flex: 1 },
  verifyButton: {
    backgroundColor: colors.surfaceAlt,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  verifyButtonDone: { backgroundColor: colors.success },
  verifyText: { color: colors.text, fontSize: 12, fontWeight: "600" },
  list: { flex: 1 },
  listContent: { padding: 16, gap: 8 },
  bubble: { maxWidth: "78%", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12 },
  bubbleSent: { backgroundColor: colors.sent, alignSelf: "flex-end" },
  bubbleReceived: { backgroundColor: colors.received, alignSelf: "flex-start" },
  bubbleText: { color: colors.text, fontSize: 15 },
  transferBar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  transferChip: {
    backgroundColor: colors.surfaceAlt,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  transferText: { color: colors.text, fontSize: 12 },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  attachButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  attachText: { color: colors.text, fontSize: 22, fontWeight: "400" },
  textInput: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    color: colors.text,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
  },
  sendButton: {
    backgroundColor: colors.accent,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 20,
  },
  sendText: { color: colors.accentText, fontSize: 15, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 12, paddingHorizontal: 16, paddingBottom: 8 },
  empty: { color: colors.textMuted, padding: 20, textAlign: "center" },
});
