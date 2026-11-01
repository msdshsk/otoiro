// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// File passed on the command line (e.g. "Open with"), if any.
#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::args().nth(1).filter(|a| !a.starts_with('-'))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_otoiro::init())
        .invoke_handler(tauri::generate_handler![initial_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
