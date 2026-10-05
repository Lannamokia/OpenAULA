// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use aula_driver_lib::commands::{self, AppState};
use aula_driver_lib::{advanced, lighting, macros, music, settings, trigger};

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
            commands::read_profile_name,
            commands::write_profile_name,
            commands::read_macros,
            commands::write_advanced_key,
            commands::delete_advanced_key,
            commands::raw_exchange,
            commands::get_tables,
            lighting::lighting_overview,
            lighting::set_zone_effect,
            lighting::set_full_keys_rgb,
            lighting::set_key_colors,
            lighting::set_lightbox_colors,
            lighting::write_custom_colors,
            lighting::read_custom_color,
            lighting::lighting_caps,
            lighting::lighting_zone,
            lighting::apply_accent_to_zones,
            macros::read_macro_capacity,
            macros::read_macro_set,
            macros::write_macro_set,
            macros::read_macro_raw,
            advanced::read_advanced_ids,
            advanced::read_advanced,
            advanced::read_advanced_key,
            advanced::set_advanced_key,
            advanced::delete_advanced_key2,
            advanced::preview_advanced,
            music::music_start,
            music::music_stop,
            music::music_status,
            music::music_frame,
            music::windows_accent_color,
            trigger::trigger_caps,
            trigger::read_rapid_triggers,
            trigger::write_rapid_triggers,
            trigger::read_key_travel,
            trigger::write_key_travel,
            trigger::read_switch_types,
            trigger::write_switch_types,
            trigger::read_safe_area,
            trigger::write_safe_area,
            trigger::read_ad_range,
            trigger::start_calibration,
            trigger::stop_calibration,
            trigger::start_travel_monitor,
            trigger::stop_travel_monitor,
            trigger::read_trigger_events,
            trigger::poll_travel_monitor,
            trigger::dropped_reports,
            settings::device_settings,
            settings::settings_caps,
            settings::set_os_mode,
            settings::set_sleep_time,
            settings::set_win_key_lock,
            settings::set_polling_rate,
            settings::set_combo_optimization,
            settings::set_adaptive_calibration,
            settings::set_debounce_mode,
            settings::set_debounce_time,
            settings::set_low_power_mode,
            settings::set_wasd_swapped,
            settings::set_side_light_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AULA driver");
}
