/**
 * Expo config plugin (R8/F6): mark the MMKV directory as excluded from
 * iCloud/iTunes backups on iOS.
 *
 * WHY a plugin: react-native-mmkv v4 stores its encrypted blob under
 * `$(Documents)/mmkv` (verified in HybridMMKVPlatformContext.swift). The
 * MMKV *encryption key* is excluded from backups via the Keychain
 * accessibility class (WHEN_UNLOCKED_THIS_DEVICE_ONLY, see
 * src/chat/mmkv-storage.ts), but the blob itself carried no
 * NSURLIsExcludedFromBackupKey — so an iCloud backup shipped the ciphertext
 * to Apple's servers. There is no runtime JS API for the flag in
 * expo-file-system or react-native-mmkv, so the attribute must be set
 * natively at app boot.
 *
 * HOW: appends a snippet to AppDelegate.swift's
 * `application(_:didFinishLaunchingWithOptions:)` that (1) eagerly creates
 * Documents/mmkkv (MMKV creates it lazily on first access — setting the
 * attribute requires the directory to exist) and (2) sets
 * `isExcludedFromBackup = true` on it. The directory is created with
 * `createDirectory(withIntermediateDirectories:)`, which does NOT reset the
 * attribute if MMKV already created it, and the flag survives because it is
 * stored on the directory inode — files MMKV later creates inside inherit
 * nothing but backups walk from marked parents... NOTE: strictly, iOS backup
 * walks directories and honors isExcludedFromBackup per item; marking the
 * DIRECTORY excludes the directory and its contents from the backup.
 *
 * FAIL LOUD: if the AppDelegate anchor cannot be found (a future RN/Expo
 * template change), prebuild throws instead of silently shipping backups.
 *
 * Android needs no equivalent: `android:allowBackup="false"` plus the
 * expo-secure-store plugin's `configureAndroidBackup: false` already cover it.
 */
const { withAppDelegate } = require("expo/config-plugins");

const ANCHOR_REGEX =
  /(func application\(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: \[UIApplication\.LaunchOptionsKey: Any\]\?\s*\)\s*->\s*Bool\s*\{)/;

const SNIPPET = `
    // [fck-mmkv-backup-exclusion] R8:F6 — keep the encrypted MMKV blob out of
    // iCloud/iTunes backups. Create the directory eagerly (MMKV creates it
    // lazily on first open) and set NSURLIsExcludedFromBackupKey before any
    // MMKV instance touches it. Excluding the directory excludes its contents.
    if let mmkvDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("mmkv", conformingTo: .directory) {
      try? FileManager.default.createDirectory(at: mmkvDir, withIntermediateDirectories: true)
      var mmkvBackupValues = URLResourceValues()
      mmkvBackupValues.isExcludedFromBackup = true
      var mmkvBackupUrl = mmkvDir
      try? mmkvBackupUrl.setResourceValues(mmkvBackupValues)
    }
`;

/** @type {import("expo/config-plugins").ConfigPlugin} */
function withMmkvBackupExclusion(config) {
  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== "swift") {
      throw new Error(
        "[mmkv-backup-exclusion] expected a Swift AppDelegate (Expo SDK 57 default). " +
          "If the template changed, update this plugin's anchor.",
      );
    }
    if (config.modResults.contents.includes("[fck-mmkv-backup-exclusion]")) {
      return config; // idempotent across repeated prebuilds
    }
    if (!ANCHOR_REGEX.test(config.modResults.contents)) {
      throw new Error(
        "[mmkv-backup-exclusion] could not find didFinishLaunchingWithOptions in AppDelegate.swift — " +
          "RN/Expo template changed; update the plugin anchor.",
      );
    }
    config.modResults.contents = config.modResults.contents.replace(ANCHOR_REGEX, `$1\n${SNIPPET}`);
    return config;
  });
}

module.exports = withMmkvBackupExclusion;
