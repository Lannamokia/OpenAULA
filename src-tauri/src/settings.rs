//! Device-level switches (docs/commands.md §1): OS mode, sleep, Win-key lock,
//! polling rate, combo optimization, adaptive calibration, debounce, low-power,
//! WASD/arrow swap and side-light sync.
//!
//! All of these are single-property reads/writes on the `0x84` / `0x04` param
//! space — unrelated to the lighting zone bases in `lighting.rs`, which use the
//! same command bytes but different params.
//!
//! | property | read | write | payload |
//! |---|---|---|---|
//! | OS mode | `0x84/17` | `0x04/17` | `0=Windows 1=macOS` |
//! | sleep time | `0x84/19` | `0x04/19` | BE16 ms |
//! | Win-key lock | `0x84/21` | `0x04/21` | `0/1` |
//! | polling rate | `0x84/23` | `0x04/23` | 0=1K 1=500 2=250 3=125 4=8K 5=4K 6=2K |
//! | combo optimization | `0x84/24` | `0x04/24` | `0/1` |
//! | adaptive calibration | `0x84/25` | `0x04/25` | `0/1` |
//! | debounce mode | `0x84/29` | `0x04/29` | 0=Normal 1=Leading 2=Trailing 3=Auto |
//! | debounce time | `0x84/30` | `0x04/30` | BE16 ms |
//! | low-power mode | `0x84/32` | `0x04/32` | `0/1` |
//! | WASD↔方向互换 | `0x84/33` | `0x04/33` | `0/1` |
//! | side-light sync | `0x84/34` | `0x04/34` | `0/1` |
//! | sleep-info raw | `0x25/0` | – | 3 bytes |

use serde::{Deserialize, Serialize};

use crate::commands::{with_device, AppState};
use crate::proto::build_app_packet;
use crate::service::AulaDevice;

pub const CMD_DEV_R: u8 = 0x84;
pub const CMD_DEV_W: u8 = 0x04;

pub const P_OS_MODE: u8 = 0x11;
pub const P_SLEEP_TIME: u8 = 0x13;
pub const P_WIN_KEY_LOCK: u8 = 0x15;
pub const P_POLLING_RATE: u8 = 0x17;
pub const P_COMBO_OPT: u8 = 0x18;
pub const P_ADAPTIVE_CAL: u8 = 0x19;
pub const P_DEBOUNCE_MODE: u8 = 0x1D;
pub const P_DEBOUNCE_TIME: u8 = 0x1E;
pub const P_LOW_POWER: u8 = 0x20;
pub const P_WASD_SWAP: u8 = 0x21;
pub const P_SIDE_SYNC: u8 = 0x22;

/** `0x84/<param>` labels for the enum-ish values (附录 A). */
pub const POLLING_RATES: [(u8, &str); 7] = [
    (0, "1KHz"),
    (1, "500Hz"),
    (2, "250Hz"),
    (3, "125Hz"),
    (4, "8KHz"),
    (5, "4KHz"),
    (6, "2KHz"),
];
pub const DEBOUNCE_MODES: [(u8, &str); 4] = [(0, "Normal"), (1, "Leading"), (2, "Trailing"), (3, "Auto")];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceSettings {
    /// 0 = Windows, 1 = macOS.
    pub os_mode: u8,
    /// Milliseconds, 0 = never sleep.
    pub sleep_time: u16,
    pub win_key_lock: bool,
    /// See `POLLING_RATES`.
    pub polling_rate: u8,
    pub combo_optimization: bool,
    pub adaptive_calibration: bool,
    /// See `DEBOUNCE_MODES`.
    pub debounce_mode: u8,
    pub debounce_time: u16,
    pub low_power_mode: bool,
    pub wasd_swapped: bool,
    pub side_light_sync: bool,
    /// `0x25/0` raw 3 bytes, meaning still unconfirmed.
    pub sleep_info_raw: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsCaps {
    /// `0x82/0x0d` — 1 = low-power mode supported.
    pub low_power_supported: bool,
    /// `0x82/0x0e` — 1 = wireless-dedicated channel supported.
    pub wireless_dedicated: bool,
    /// `0x82/0x03` supported-switch bitmap, hex (also decides magnetic vs mechanical).
    pub supported_switches: String,
}

impl AulaDevice {
    fn read_u8(&self, param: u8) -> Option<u8> {
        self.read_cmd(CMD_DEV_R, param, 1).ok().map(|d| d[0])
    }

    fn read_be16(&self, param: u8) -> Option<u16> {
        self.read_cmd(CMD_DEV_R, param, 2)
            .ok()
            .map(|d| u16::from_be_bytes([d[0], d[1]]))
    }

    fn write_u8(&self, param: u8, v: u8) -> Result<(), String> {
        self.send_command(&build_app_packet(CMD_DEV_W, param, &[v]))?;
        Ok(())
    }

    fn write_be16(&self, param: u8, v: u16) -> Result<(), String> {
        self.send_command(&build_app_packet(CMD_DEV_W, param, &v.to_be_bytes()))?;
        Ok(())
    }

    pub fn device_settings(&self) -> Result<DeviceSettings, String> {
        Ok(DeviceSettings {
            os_mode: self.read_u8(P_OS_MODE).unwrap_or(0),
            sleep_time: self.read_be16(P_SLEEP_TIME).unwrap_or(0),
            win_key_lock: self.read_u8(P_WIN_KEY_LOCK).unwrap_or(0) != 0,
            polling_rate: self.read_u8(P_POLLING_RATE).unwrap_or(0),
            combo_optimization: self.read_u8(P_COMBO_OPT).unwrap_or(0) != 0,
            adaptive_calibration: self.read_u8(P_ADAPTIVE_CAL).unwrap_or(0) != 0,
            debounce_mode: self.read_u8(P_DEBOUNCE_MODE).unwrap_or(0),
            debounce_time: self.read_be16(P_DEBOUNCE_TIME).unwrap_or(0),
            low_power_mode: self.read_u8(P_LOW_POWER).unwrap_or(0) != 0,
            wasd_swapped: self.read_u8(P_WASD_SWAP).unwrap_or(0) != 0,
            side_light_sync: self.read_u8(P_SIDE_SYNC).unwrap_or(0) != 0,
            sleep_info_raw: self.read_cmd(0x25, 0x00, 3).unwrap_or_default(),
        })
    }

    pub fn settings_caps(&self) -> SettingsCaps {
        SettingsCaps {
            low_power_supported: self.read_cmd(0x82, 0x0D, 1).map(|d| d[0] == 1).unwrap_or(false),
            wireless_dedicated: self.read_cmd(0x82, 0x0E, 1).map(|d| d[0] == 1).unwrap_or(false),
            supported_switches: crate::commands::hex(&self.read_cmd(0x82, 0x03, 16).unwrap_or_default()),
        }
    }

    pub fn set_os_mode(&self, mode: u8) -> Result<(), String> {
        if mode > 1 {
            return Err("OS 模式只能是 0(Windows) / 1(macOS)".into());
        }
        self.write_u8(P_OS_MODE, mode)
    }
    pub fn set_sleep_time(&self, ms: u16) -> Result<(), String> {
        self.write_be16(P_SLEEP_TIME, ms)
    }
    pub fn set_win_key_lock(&self, on: bool) -> Result<(), String> {
        self.write_u8(P_WIN_KEY_LOCK, on as u8)
    }
    pub fn set_polling_rate(&self, rate: u8) -> Result<(), String> {
        if rate > 6 {
            return Err("回报率档位 0..6".into());
        }
        self.write_u8(P_POLLING_RATE, rate)
    }
    pub fn set_combo_optimization(&self, on: bool) -> Result<(), String> {
        self.write_u8(P_COMBO_OPT, on as u8)
    }
    pub fn set_adaptive_calibration(&self, on: bool) -> Result<(), String> {
        self.write_u8(P_ADAPTIVE_CAL, on as u8)
    }
    pub fn set_debounce_mode(&self, mode: u8) -> Result<(), String> {
        if mode > 3 {
            return Err("消抖模式 0..3".into());
        }
        self.write_u8(P_DEBOUNCE_MODE, mode)
    }
    pub fn set_debounce_time(&self, ms: u16) -> Result<(), String> {
        self.write_be16(P_DEBOUNCE_TIME, ms)
    }
    pub fn set_low_power_mode(&self, on: bool) -> Result<(), String> {
        self.write_u8(P_LOW_POWER, on as u8)
    }
    pub fn set_wasd_swapped(&self, on: bool) -> Result<(), String> {
        self.write_u8(P_WASD_SWAP, on as u8)
    }
    pub fn set_side_light_sync(&self, on: bool) -> Result<(), String> {
        self.write_u8(P_SIDE_SYNC, on as u8)
    }
}

#[tauri::command]
pub fn device_settings(state: tauri::State<'_, AppState>) -> Result<DeviceSettings, String> {
    with_device(&state, |d| d.device_settings())
}

#[tauri::command]
pub fn settings_caps(state: tauri::State<'_, AppState>) -> Result<SettingsCaps, String> {
    with_device(&state, |d| Ok(d.settings_caps()))
}

macro_rules! setter {
    ($name:ident, $ty:ty, $method:ident) => {
        #[tauri::command]
        pub fn $name(state: tauri::State<'_, AppState>, value: $ty) -> Result<(), String> {
            with_device(&state, |d| d.$method(value))
        }
    };
}

setter!(set_os_mode, u8, set_os_mode);
setter!(set_sleep_time, u16, set_sleep_time);
setter!(set_win_key_lock, bool, set_win_key_lock);
setter!(set_polling_rate, u8, set_polling_rate);
setter!(set_combo_optimization, bool, set_combo_optimization);
setter!(set_adaptive_calibration, bool, set_adaptive_calibration);
setter!(set_debounce_mode, u8, set_debounce_mode);
setter!(set_debounce_time, u16, set_debounce_time);
setter!(set_low_power_mode, bool, set_low_power_mode);
setter!(set_wasd_swapped, bool, set_wasd_swapped);
setter!(set_side_light_sync, bool, set_side_light_sync);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polling_rate_table_covers_0_to_6() {
        for (i, (v, _)) in POLLING_RATES.iter().enumerate() {
            assert_eq!(*v as usize, i);
        }
        assert_eq!(DEBOUNCE_MODES[3], (3, "Auto"));
    }
}
