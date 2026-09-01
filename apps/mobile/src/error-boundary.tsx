/**
 * Top-level React error boundary (R8/F2). The chat screens call
 * `useChatController()` during render, which throws while the provider has
 * not finished constructing — and any other unexpected render-phase throw
 * (bad state shape, missing native module) would otherwise be an unhandled
 * JS exception: red screen in dev, app crash in release. React requires
 * error boundaries to be class components (`getDerivedStateFromError` /
 * `componentDidCatch` have no hook equivalent), so this is deliberately the
 * one class component in the mobile app.
 *
 * The rendered fallback is REDACTED by design: arbitrary render errors can
 * carry internal detail (broker/TURN URLs, identity material in messages).
 * The original error is logged for diagnostics only, mirroring the
 * provider's state.error redaction convention.
 */
import * as React from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors } from "./ui/colors";

interface AppErrorBoundaryProps {
  readonly children: React.ReactNode;
}

interface AppErrorBoundaryState {
  readonly caught: boolean;
}

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  override readonly state: AppErrorBoundaryState = { caught: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { caught: true };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Diagnostics only — never rendered. componentStack localizes the throw
    // to a screen/component without exposing it to the user.
    console.warn("AppErrorBoundary caught a render error", error, info.componentStack);
  }

  override render(): React.ReactNode {
    if (this.state.caught) {
      return (
        <View style={styles.screen}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            The chat interface hit an unexpected error and had to stop. Restart the app to continue.
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 24, gap: 12 },
  title: { color: colors.danger, fontSize: 20, fontWeight: "700" },
  body: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
});
