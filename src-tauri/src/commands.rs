//! Tauri command layer: exposes the service to the webview.

use std::sync::Mutex;

use serde::Serialize;

use crate::hid::{DeviceDesc, Hid};
use crate::service::{AulaDevice, Battery, KeyEntry};

pub struct AppState {
    pub hid: Mutex<Option<Hid>>,
    pub device: Mutex<Option<AulaDevice>>,
}

fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    let hex = hex.trim();
    let hex = hex.strip_prefix("0x").unwrap_or(hex);
    if hex.len() % 2 != 0 {
        return Err("hex string must have an even length".into());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

pub(crate) fn with_device<T>(
    state: &tauri::State<'_, AppState>,
    f: impl FnOnce(&AulaDevice) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state.device.lock().map_err(|e| e.to_string())?;
    let dev = guard.as_ref().ok_or("device not open")?;
    f(dev)
}

#[tauri::command]
pub fn list_devices(state: tauri::State<'_, AppState>) -> Result<Vec<DeviceDesc>, String> {
    let mut guard = state.hid.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(Hid::new()?);
    }
    Ok(guard.as_mut().unwrap().list())
}

#[tauri::command]
pub fn open_device(state: tauri::State<'_, AppState>, path: Option<String>) -> Result<OpenResult, String> {
    let mut hid_guard = state.hid.lock().map_err(|e| e.to_string())?;
    if hid_guard.is_none() {
        *hid_guard = Some(Hid::new()?);
    }
    let (dev, desc) = match &path {
        Some(p) => hid_guard.as_mut().unwrap().open_path(p)?,
        None => hid_guard.as_mut().unwrap().open(None)?,
    };
    // Second handle for the reader thread. `hidapi` opens the interface with
    // FILE_SHARE_READ | FILE_SHARE_WRITE, so the write handle stays usable.
    // No silent fallback to polling: a reader thread that cannot read would
    // look like a device that never answers.
    let reader = hid_guard
        .as_mut()
        .unwrap()
        .open_raw(&desc.path)
        .map_err(|e| format!("无法打开读取句柄（{}）：{e}", desc.path))?;
    drop(hid_guard);
    let aula = AulaDevice::new(dev, reader, desc.clone());
    // Probe before reporting success: the wireless keyboard sleeps when idle and
    // then answers nothing at all, which would otherwise look like a hung app.
    let awake = aula.probe(CONNECT_PROBE);
    *state.device.lock().map_err(|e| e.to_string())? = Some(aula);
    Ok(OpenResult { device: desc, awake })
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenResult {
    pub device: DeviceDesc,
    /// False when the connect probe went unanswered — on the wireless link that
    /// almost always means the keyboard is asleep, not that it is broken.
    pub awake: bool,
}

/// Probe budget when connecting: long enough for a slow wireless round trip,
/// short enough that a sleeping keyboard does not feel like a hang.
const CONNECT_PROBE: std::time::Duration = std::time::Duration::from_secs(5);

#[tauri::command]
pub fn close_device(state: tauri::State<'_, AppState>) -> Result<(), String> {
    *state.device.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceStatus {
    pub product: Option<String>,
    pub manufacturer: Option<String>,
    pub vendor_id: u16,
    pub product_id: u16,
    pub framed: bool,
    pub uuid: Option<String>,
    pub firmware: Option<String>,
    pub battery: Option<Battery>,
    pub profile: Option<u8>,
}

#[tauri::command]
pub fn device_status(state: tauri::State<'_, AppState>) -> Result<DeviceStatus, String> {
    with_device(&state, |d| {
        Ok(DeviceStatus {
            product: d.desc.product.clone(),
            manufacturer: d.desc.manufacturer.clone(),
            vendor_id: d.desc.vendor_id,
            product_id: d.desc.product_id,
            framed: d.is_framed(),
            uuid: d.uuid().ok().map(|u| hex(&u)),
            firmware: d.firmware_version().ok(),
            battery: d.battery().ok(),
            profile: d.profile().ok(),
        })
    })
}

#[tauri::command]
pub fn read_keymap(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    ids: Vec<u16>,
) -> Result<Vec<KeyEntry>, String> {
    with_device(&state, |d| d.read_keymap(layer, system, &ids))
}

#[tauri::command]
pub fn write_keymap(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    entries: Vec<KeyEntry>,
) -> Result<(), String> {
    with_device(&state, |d| d.write_keymap(layer, system, &entries))
}

#[tauri::command]
pub fn get_profile(state: tauri::State<'_, AppState>) -> Result<u8, String> {
    with_device(&state, |d| d.profile())
}

#[tauri::command]
pub fn switch_profile(state: tauri::State<'_, AppState>, n: u8) -> Result<(), String> {
    with_device(&state, |d| d.switch_profile(n))
}

/// `0x9A/<profile>` — onboard profile name (None = 未命名).
#[tauri::command]
pub fn read_profile_name(
    state: tauri::State<'_, AppState>,
    profile: u8,
) -> Result<Option<String>, String> {
    with_device(&state, |d| d.read_profile_name(profile))
}

/// `0x1A/<profile>` — set the onboard profile name (`[len, ...UTF-8]`, ≤ 55 bytes).
#[tauri::command]
pub fn write_profile_name(
    state: tauri::State<'_, AppState>,
    profile: u8,
    name: String,
) -> Result<(), String> {
    with_device(&state, |d| d.write_profile_name(profile, &name))
}

#[tauri::command]
pub fn read_macros(state: tauri::State<'_, AppState>, total_len: usize) -> Result<String, String> {
    with_device(&state, |d| d.read_macro_region(total_len).map(|v| hex(&v)))
}

#[tauri::command]
pub fn write_advanced_key(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    key_type: u8,
    data: Vec<u8>,
) -> Result<(), String> {
    with_device(&state, |d| d.write_advanced_key(layer, system, key_type, &data))
}

#[tauri::command]
pub fn delete_advanced_key(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    id: u16,
) -> Result<(), String> {
    with_device(&state, |d| d.delete_advanced_key(layer, system, id))
}

#[derive(Debug, Clone, Serialize)]
pub struct RawResult {
    pub request: String,
    pub response: Option<String>,
}

#[tauri::command]
pub fn raw_exchange(
    state: tauri::State<'_, AppState>,
    cmd: u8,
    param: u8,
    data: String,
) -> Result<RawResult, String> {
    let data = hex_to_bytes(&data)?;
    with_device(&state, |d| {
        let (req, res) = d.raw_exchange(cmd, param, &data)?;
        Ok(RawResult {
            request: req,
            response: res,
        })
    })
}

/// Bundled data tables (models / keyboard map / axes / keycodes / layout).
/// Same JSON as the frontend's `src/data`, embedded so the backend can also
/// use them (e.g. model lookup by UUID).
#[tauri::command]
pub fn get_tables() -> Result<serde_json::Value, String> {
    let models = include_str!("../data/models.json");
    let keyboard_map = include_str!("../data/keyboard_map.json");
    let axes = include_str!("../data/axes.json");
    let keycodes = include_str!("../data/keycodes.json");
    let layout68 = include_str!("../data/layout68.json");
    Ok(serde_json::json!({
        "models": serde_json::from_str::<serde_json::Value>(models).map_err(|e| e.to_string())?,
        "keyboard_map": serde_json::from_str::<serde_json::Value>(keyboard_map).map_err(|e| e.to_string())?,
        "axes": serde_json::from_str::<serde_json::Value>(axes).map_err(|e| e.to_string())?,
        "keycodes": serde_json::from_str::<serde_json::Value>(keycodes).map_err(|e| e.to_string())?,
        "layout68": serde_json::from_str::<serde_json::Value>(layout68).map_err(|e| e.to_string())?,
    }))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
