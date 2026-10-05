// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use aula_driver_lib::commands::{
    self, AppState,
};

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            hid: Mutex::new(None),
            device: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_devices,
            commands::open_device,
            commands::close_device,
            commands::device_status,
            commands::read_keymap,
            commands::write_keymap,
            commands::get_profile,
            commands::switch_profile,
            commands::read_macros,
            commands::write_advanced_key,
            commands::delete_advanced_key,
            commands::raw_exchange,
            commands::get_tables,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AULA driver");
}
