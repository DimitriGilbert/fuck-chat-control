/**
 * Tri-state theme ("system" | "light" | "dark") for the chat shell.
 *
 * Persistence: `next-themes` owns the runtime — it reads/writes
 * {@link THEME_STORAGE_KEY} in localStorage, honors `prefers-color-scheme`
 * when the stored preference is "system" (or absent), and toggles the
 * `light`/`dark` class + `color-scheme` style on `<html>`
 * (`attribute="class"`). The palette itself lives ONCE in
 * `packages/ui/src/styles/globals.css` (`:root` light tokens + `.dark`
 * overrides); nothing else hard-codes a color.
 *
 * Pre-paint: {@link THEME_INIT_SCRIPT} is injected as a blocking inline
 * script in the SSR `<head>` (see routes/__root.tsx). It reproduces exactly
 * the provider's resolution — stored preference else media query — so the
 * correct class is on `<html>` before first paint and there is no flash or
 * hydration mismatch (`<html suppressHydrationWarning>` covers the class /
 * style attributes the script and provider mutate).
 *
 * The script is a string constant, not a bundled module: it must run during
 * initial HTML parse, before React and before the stylesheet paints.
 */

/** localStorage key shared by the init script and the ThemeProvider. */
export const THEME_STORAGE_KEY = "fck-theme";

/** The three selectable preferences. "system" follows the OS. */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

/**
 * Blocking pre-paint bootstrap. Reads the stored preference, resolves
 * "system" via the media query, and writes the resolved class + colorScheme
 * onto <html>. Wrapped in try/catch so a storage-denied webview (private
 * mode, some Tauri configs) degrades to a media-query or light default
 * instead of breaking parse.
 *
 * Kept byte-stable and dependency-free: this runs before any framework code.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(
  THEME_STORAGE_KEY,
)};var s=null;try{s=window.localStorage.getItem(k);}catch(e){}var d=s==="dark"||(s!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.remove("light","dark");r.classList.add(d?"dark":"light");r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
