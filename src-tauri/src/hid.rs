//! HID enumeration / open, filtered by the AULA configuration interface
//! (`usage_page = 0xFF60`, `usage = 0x61`). The keyboard/mouse/consumer
//! interfaces (MI_00/MI_01) are unrelated to the protocol and must be
//! filtered out. Ported from `Aula.open()` in `tools/aula_hid.py`.

use crate::proto::{USAGE, USAGE_PAGE, VID};
use hidapi::{DeviceInfo, HidApi, HidDevice};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DeviceDesc {
    pub path: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub usage_page: u16,
    pub usage: u16,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial: Option<String>,
    /// True when this device needs the 0x66 frame/ACK link (PID 0x106C).
    pub framed: bool,
}

impl DeviceDesc {
    pub fn from_info(d: &DeviceInfo) -> Self {
        let pid = d.product_id();
        DeviceDesc {
            path: d.path().to_string_lossy().into_owned(),
            vendor_id: d.vendor_id(),
            product_id: pid,
            usage_page: d.usage_page(),
            usage: d.usage(),
            manufacturer: d.manufacturer_string().map(|s| s.to_string()),
            product: d.product_string().map(|s| s.to_string()),
            serial: d.serial_number().map(|s| s.to_string()),
            framed: pid == crate::proto::WIRELESS_PID,
        }
    }
}

pub struct Hid {
    pub api: HidApi,
}

impl Hid {
    pub fn new() -> Result<Self, String> {
        HidApi::new().map(|api| Self { api }).map_err(|e| e.to_string())
    }

    /// All AULA configuration interfaces, regardless of PID.
    pub fn list(&self) -> Vec<DeviceDesc> {
        self.api
            .device_list()
            .filter(|d| d.vendor_id() == VID && d.usage_page() == USAGE_PAGE && d.usage() == USAGE)
            .map(DeviceDesc::from_info)
            .collect()
    }

    /// Open the first configuration interface matching `pid` (any PID if None).
    pub fn open(&self, pid: Option<u16>) -> Result<(HidDevice, DeviceDesc), String> {
        let info = self
            .api
            .device_list()
            .find(|d| {
                d.vendor_id() == VID
                    && d.usage_page() == USAGE_PAGE
                    && d.usage() == USAGE
                    && (pid.is_none() || d.product_id() == pid.unwrap())
            })
            .ok_or_else(|| format!("configuration interface not found (pid={pid:?})"))?;
        let desc = DeviceDesc::from_info(info);
        let dev = self.api.open_path(info.path()).map_err(|e| e.to_string())?;
        Ok((dev, desc))
    }

    /// Open an already-enumerated path **without** re-scanning the device list.
    ///
    /// Used to hand a second handle to `AulaDevice`'s reader thread: the path
    /// comes from the descriptor of the handle already open, so there is no
    /// reason to re-enumerate (and re-enumeration could miss the device while
    /// it is mid-reconfigure) — `hidapi` opens with `FILE_SHARE_READ |
    /// FILE_SHARE_WRITE`, so both handles can coexist.
    pub fn open_raw(&self, path: &str) -> Result<HidDevice, String> {
        let cpath = std::ffi::CString::new(path).map_err(|e| e.to_string())?;
        self.api.open_path(&cpath).map_err(|e| e.to_string())
    }

    /// Open a specific configuration interface by its enumerated path.
    pub fn open_path(&self, path: &str) -> Result<(HidDevice, DeviceDesc), String> {
        let info = self
            .api
            .device_list()
            .find(|d| {
                d.vendor_id() == VID
                    && d.usage_page() == USAGE_PAGE
                    && d.usage() == USAGE
                    && d.path().to_string_lossy() == path
            })
            .ok_or_else(|| format!("configuration interface not found (path={path})"))?;
        let desc = DeviceDesc::from_info(info);
        let dev = self.api.open_path(info.path()).map_err(|e| e.to_string())?;
        Ok((dev, desc))
    }
}
