/**
 * Minimal palette for the v1 RN UI. No theming library — just enough to keep
 * the screens readable in light + dark. Deferred per PLAN: real theming, an
 * icon set, and a component library land in a later phase.
 */
export const colors = {
  bg: "#0a0a0a",
  surface: "#161616",
  surfaceAlt: "#1f1f1f",
  text: "#f5f5f5",
  textMuted: "#a0a0a0",
  accent: "#3b82f6",
  accentText: "#ffffff",
  border: "#2a2a2a",
  danger: "#ef4444",
  success: "#22c55e",
  sent: "#2563eb",
  received: "#262626",
} as const;
