// Prevents an additional console window on Windows in release builds. On
// Linux/macOS this is a no-op.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fck_chat_control_desktop_lib::run()
}
