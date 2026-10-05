//! Magnetic-axis trigger service (docs/commands.md §7).
//!
//! Per-key records, all big-endian, all addressed by `ELS(layer, system)`
//! except the switch type (param 0) and the AD range (`0x94/0x05`):
//!
//! | what | read | write | record |
//! |---|---|---|---|
//! | rapid trigger | `0x99` | `0x19` | `BE16(id), enable, BE16(press), BE16(release), 0` (8 B, ≤7/pkt) |
//! | key travel | `0x93` | `0x13` | `BE16(id), BE16(travel), 0` (5 B, ≤11/pkt) |
//! | switch type | `0x95` | `0x15` | `BE16(id), switchType` (3 B, ≤18/pkt) |
//! | dead zone | `0x96` | `0x16` | `BE16(id), BE16(top), BE16(bottom), 0, enable` (8 B, ≤7/pkt) |
//! | AD range | `0x94/0x05` | – | `BE16(id), BE16(max), BE16(min)` (6 B, ≤9/pkt) |
//!
//! Protocol integers are in units of `travelPrecision` (0.005 mm on this board),
//! so `mm × 200`. The UI stays in mm and converts here.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::commands::{with_device, AppState};
use crate::proto::{build_app_packet, build_packets, els, event_data};
use crate::service::AulaDevice;

pub const CMD_RT_R: u8 = 0x99;
pub const CMD_RT_W: u8 = 0x19;
pub const CMD_TRAVEL_R: u8 = 0x93;
pub const CMD_TRAVEL_W: u8 = 0x13;
pub const CMD_SWITCH_R: u8 = 0x95;
pub const CMD_SWITCH_W: u8 = 0x15;
pub const CMD_SAFE_R: u8 = 0x96;
pub const CMD_SAFE_W: u8 = 0x16;
/// `0x94` shared by AD-range read (param 5) and calibration (params 0 / 4).
pub const CMD_CAL: u8 = 0x94;
pub const CAL_AD_RANGE: u8 = 0x05;
pub const CAL_START: u8 = 0x00;
pub const CAL_STOP: u8 = 0x04;
/// `0x98` travel monitor: Start = param 0, Stop = param 2, the stream itself
/// arrives as normal envelope packets with `param = 1` (measured).
/// `0x98` travel monitor. Measured semantics:
///   - `param 0`, no data  → monitor the device's default set (streams whatever changes)
///   - `param 1`, `BE16 id…` → **monitor exactly these keys** (≤28 ids per packet)
///   - `param 2`, no data  → stop
/// The stream itself arrives as normal envelope packets with `param = 1`.
pub const CMD_TRAVEL_MON: u8 = 0x98;
pub const MON_START_ALL: u8 = 0x00;
pub const MON_START_KEYS: u8 = 0x01;
pub const MON_STOP: u8 = 0x02;
/// 28 ids × 2 bytes = 56 bytes, the most a single request packet holds.
pub const MON_MAX_KEYS: usize = 28;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RapidTrigger {
    pub id: u16,
    pub enable: u8,
    pub press: u16,
    pub release: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyTravel {
    pub id: u16,
    pub travel: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwitchType {
    pub id: u16,
    pub switch_type: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafeArea {
    pub id: u16,
    pub top: u16,
    pub bottom: u16,
    pub enable: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdRange {
    pub id: u16,
    pub max: u16,
    pub min: u16,
}

/// One sample of the `0x98` travel-monitor stream (6 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TravelSample {
    pub id: u16,
    pub distance: u16,
    /// bit15 of the third field.
    pub press: bool,
    /// low 15 bits of the third field (raw ADC).
    pub ad: u16,
}

/// One `0x94`/param 2 calibration record (6 bytes).
///
/// Field layout and **bit polarity** come from the SDK parser
/// (`onKeyCalibration`): `press = (bit15 === 0)`, `finished = (bit15 === 1)` —
/// i.e. bit15 means "this key's calibration is done", which is exactly what the
/// official page colours the key with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalibrationSample {
    pub id: u16,
    pub ad: u16,
    pub min: u16,
    pub finished: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TriggerCaps {
    /// `0x82/0x08` — one protocol unit in 0.001 mm (5 on this board = 0.005 mm).
    pub travel_precision: u8,
    /// `0x82/0x06` — minimum rapid-trigger value, same unit as above.
    pub min_rapid_trigger: u8,
    /// `0x82/0x03` supported-switch bitmap, hex.
    pub supported_switches: String,
    /// Readable ids from the bitmap (LSB first, bit i ⇒ switch i).
    pub switch_ids: Vec<u16>,
    /// `0x82/0x04` advanced-key-type bitmap, bit0..6 ⇒ TGL/MT/DKS/SOCD/MPT/END/RS.
    pub advanced_key_types: u8,
    /// Bitmap non-empty ⇒ magnetic board.
    pub magnetic: bool,
}

fn be16(d: &[u8], p: usize) -> u16 {
    u16::from_be_bytes([d[p], d[p + 1]])
}

/// Read per-key records in chunks that keep the reply inside one 56-byte packet.
fn read_records(
    d: &AulaDevice,
    cmd: u8,
    param: u8,
    ids: &[u16],
    per_packet: usize,
    rec: usize,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for chunk in ids.chunks(per_packet) {
        let mut data = Vec::with_capacity(chunk.len() * 2);
        for id in chunk {
            data.extend_from_slice(&id.to_be_bytes());
        }
        let pkt = build_app_packet(cmd, param, &data);
        let r = d.exchange(&pkt)?.ok_or("no reply (timeout)")?;
        // dataLength is unreliable on reads -> take the fixed record size.
        let n = (chunk.len() * rec).min(56);
        out.extend_from_slice(&r[6..6 + n]);
    }
    Ok(out)
}

fn write_records(d: &AulaDevice, cmd: u8, param: u8, data: &[u8], per_packet: usize) -> Result<(), String> {
    for p in build_packets(cmd, param, data, per_packet) {
        d.exchange(&p)?;
    }
    Ok(())
}

impl AulaDevice {
    /// `0x82/0x03`, `0x82/0x04`, `0x82/0x06`, `0x82/0x08` — trigger capabilities.
    pub fn trigger_caps(&self) -> Result<TriggerCaps, String> {
        let switches = self.read_cmd(0x82, 0x03, 16).unwrap_or_default();
        let adv = self.read_cmd(0x82, 0x04, 8).unwrap_or_default();
        let precision = self.read_cmd(0x82, 0x08, 1).map(|d| d[0]).unwrap_or(0);
        let min_rt = self.read_cmd(0x82, 0x06, 1).map(|d| d[0]).unwrap_or(0);
        // The advanced-key bitmap skips its first byte (`docs/commands.md` §1.1).
        let adv_bits = adv.get(1).copied().unwrap_or(0);
        let mut switch_ids = Vec::new();
        for (byte_idx, &b) in switches.iter().enumerate() {
            for bit in 0..8usize {
                if b & (1 << bit) != 0 {
                    switch_ids.push((byte_idx * 8 + bit) as u16);
                }
            }
        }
        Ok(TriggerCaps {
            travel_precision: precision,
            min_rapid_trigger: min_rt,
            supported_switches: crate::commands::hex(&switches),
            magnetic: !switch_ids.is_empty(),
            switch_ids,
            advanced_key_types: adv_bits,
        })
    }

    pub fn read_rapid_triggers(&self, layer: u8, system: u8, ids: &[u16]) -> Result<Vec<RapidTrigger>, String> {
        let d = read_records(self, CMD_RT_R, els(layer, system), ids, 7, 8)?;
        Ok(d.chunks_exact(8)
            .map(|c| RapidTrigger {
                id: be16(c, 0),
                enable: c[2],
                press: be16(c, 3),
                release: be16(c, 5),
            })
            .collect())
    }

    pub fn write_rapid_triggers(&self, layer: u8, system: u8, list: &[RapidTrigger]) -> Result<(), String> {
        let mut data = Vec::with_capacity(list.len() * 8);
        for r in list {
            data.extend_from_slice(&r.id.to_be_bytes());
            data.push(r.enable);
            data.extend_from_slice(&r.press.to_be_bytes());
            data.extend_from_slice(&r.release.to_be_bytes());
            data.push(0);
        }
        write_records(self, CMD_RT_W, els(layer, system), &data, 56)
    }

    pub fn read_key_travel(&self, layer: u8, system: u8, ids: &[u16]) -> Result<Vec<KeyTravel>, String> {
        let d = read_records(self, CMD_TRAVEL_R, els(layer, system), ids, 11, 5)?;
        Ok(d.chunks_exact(5)
            .map(|c| KeyTravel { id: be16(c, 0), travel: be16(c, 2) })
            .collect())
    }

    pub fn write_key_travel(&self, layer: u8, system: u8, list: &[KeyTravel]) -> Result<(), String> {
        let mut data = Vec::with_capacity(list.len() * 5);
        for k in list {
            data.extend_from_slice(&k.id.to_be_bytes());
            data.extend_from_slice(&k.travel.to_be_bytes());
            data.push(0);
        }
        write_records(self, CMD_TRAVEL_W, els(layer, system), &data, 55)
    }

    pub fn read_switch_types(&self, ids: &[u16]) -> Result<Vec<SwitchType>, String> {
        let d = read_records(self, CMD_SWITCH_R, 0x00, ids, 18, 3)?;
        Ok(d.chunks_exact(3)
            .map(|c| SwitchType { id: be16(c, 0), switch_type: c[2] })
            .collect())
    }

    pub fn write_switch_types(&self, list: &[SwitchType]) -> Result<(), String> {
        let mut data = Vec::with_capacity(list.len() * 3);
        for s in list {
            data.extend_from_slice(&s.id.to_be_bytes());
            data.push(s.switch_type);
        }
        write_records(self, CMD_SWITCH_W, 0x00, &data, 54)
    }

    pub fn read_safe_area(&self, ids: &[u16]) -> Result<Vec<SafeArea>, String> {
        let d = read_records(self, CMD_SAFE_R, 0x00, ids, 7, 8)?;
        Ok(d.chunks_exact(8)
            .map(|c| {
                let top = be16(c, 2);
                let bottom = be16(c, 4);
                // Unset slots come back as `id ff ff ff ff 00 c8` — both limits
                // 0xffff and a garbage trailing byte. Report them as "not configured"
                // instead of surfacing 327mm sliders and enable=200.
                if top == 0xFFFF && bottom == 0xFFFF {
                    SafeArea { id: be16(c, 0), top: 0, bottom: 0, enable: 0 }
                } else {
                    SafeArea { id: be16(c, 0), top, bottom, enable: c[7].min(1) }
                }
            })
            .collect())
    }

    pub fn write_safe_area(&self, list: &[SafeArea]) -> Result<(), String> {
        let mut data = Vec::with_capacity(list.len() * 8);
        for s in list {
            data.extend_from_slice(&s.id.to_be_bytes());
            data.extend_from_slice(&s.top.to_be_bytes());
            data.extend_from_slice(&s.bottom.to_be_bytes());
            data.push(0);
            data.push(s.enable);
        }
        write_records(self, CMD_SAFE_W, 0x00, &data, 56)
    }

    pub fn read_ad_range(&self, ids: &[u16]) -> Result<Vec<AdRange>, String> {
        let d = read_records(self, CMD_CAL, CAL_AD_RANGE, ids, 9, 6)?;
        Ok(d.chunks_exact(6)
            .map(|c| AdRange { id: be16(c, 0), max: be16(c, 2), min: be16(c, 4) })
            .collect())
    }

    /// `0x94/0x00` — the SDK re-sends this every second while calibrating, so
    /// it is fire-and-forget **on the wired link** (the stream carries progress);
    /// on wireless it must complete the ACK handshake to be delivered at all.
    pub fn start_calibration(&self) -> Result<(), String> {
        self.send_app_packet(&build_app_packet(CMD_CAL, CAL_START, &[]))
    }

    pub fn stop_calibration(&self) -> Result<(), String> {
        self.exchange(&build_app_packet(CMD_CAL, CAL_STOP, &[]))?;
        Ok(())
    }

    /// `0x98/0x01` — ask the device for one snapshot of `ids`
    /// (empty = `0x98/0x00`, the device's own default set).
    ///
    /// ⚠ This is **not** a stream: each call yields exactly one report, so the
    /// call rate *is* the sample rate — see `poll_travel_monitor`.
    pub fn start_travel_monitor(&self, ids: &[u16]) -> Result<(), String> {
        if ids.is_empty() {
            return self.send_app_packet(&build_app_packet(CMD_TRAVEL_MON, MON_START_ALL, &[]));
        }
        if ids.len() > MON_MAX_KEYS {
            return Err(format!("一次最多监测 {} 个键（收到 {}）", MON_MAX_KEYS, ids.len()));
        }
        let mut data = Vec::with_capacity(ids.len() * 2);
        for id in ids {
            data.extend_from_slice(&id.to_be_bytes());
        }
        self.send_app_packet(&build_app_packet(CMD_TRAVEL_MON, MON_START_KEYS, &data))
    }

    /// Sample every monitored key once — one call per UI tick.
    ///
    /// Wired: the command is fire-and-forget and the reply lands in the reader
    /// queue, so this can run at the UI's pace (~250 Hz).
    /// Wireless: a command only completes through the ACK handshake (~110 ms on
    /// this receiver), so take the reply of that same exchange instead of
    /// expecting anything from the queue.
    pub fn poll_travel_monitor(
        &self,
        ids: &[u16],
        timeout_ms: u64,
    ) -> Result<(Vec<TravelSample>, Vec<CalibrationSample>), String> {
        if self.is_framed() {
            let (param, data) = if ids.is_empty() || ids.len() > MON_MAX_KEYS {
                (MON_START_ALL, Vec::new())
            } else {
                let mut d = Vec::with_capacity(ids.len() * 2);
                for id in ids {
                    d.extend_from_slice(&id.to_be_bytes());
                }
                (MON_START_KEYS, d)
            };
            let pkt = build_app_packet(CMD_TRAVEL_MON, param, &data);
            let r = self.exchange(&pkt)?.ok_or("no reply (timeout)")?;
            let n = (r[5] as usize).min(56);
            let mut travel = Vec::new();
            for c in r[6..6 + n].chunks_exact(6) {
                let f = be16(c, 4);
                travel.push(TravelSample {
                    id: be16(c, 0),
                    distance: be16(c, 2),
                    press: f & 0x8000 != 0,
                    ad: f & 0x7FFF,
                });
            }
            return Ok((travel, Vec::new()));
        }
        self.start_travel_monitor(ids)?;
        self.read_trigger_events(timeout_ms)
    }

    pub fn stop_travel_monitor(&self) -> Result<(), String> {
        self.exchange(&build_app_packet(CMD_TRAVEL_MON, MON_STOP, &[]))?;
        Ok(())
    }

    /// Collect whatever the device pushed within `timeout_ms` and split it into
    /// travel samples / calibration samples.
    pub fn read_trigger_events(&self, timeout_ms: u64) -> Result<(Vec<TravelSample>, Vec<CalibrationSample>), String> {
        let pkts = self.drain_event_packets(Duration::from_millis(timeout_ms))?;
        let mut travel = Vec::new();
        let mut calib = Vec::new();
        for p in pkts {
            let data = event_data(&p);
            match p[0] {
                0x98 => {
                    for c in data.chunks_exact(6) {
                        let f = be16(c, 4);
                        travel.push(TravelSample {
                            id: be16(c, 0),
                            distance: be16(c, 2),
                            press: f & 0x8000 != 0,
                            ad: f & 0x7FFF,
                        });
                    }
                }
                // Measured 2026-10-06: arrives as a normal 63-byte envelope packet
                // (`94 02 00 01 00 06 | 00 01 85 68 05 65 | …`), 6 bytes per record.
                0x94 if p[1] == 2 => {
                    for c in data.chunks_exact(6) {
                        let f = be16(c, 2);
                        calib.push(CalibrationSample {
                            id: be16(c, 0),
                            ad: f & 0x7FFF,
                            min: be16(c, 4),
                            finished: f & 0x8000 != 0,
                        });
                    }
                }
                _ => {}
            }
        }
        Ok((travel, calib))
    }
}

#[tauri::command]
pub fn trigger_caps(state: tauri::State<'_, AppState>) -> Result<TriggerCaps, String> {
    with_device(&state, |d| d.trigger_caps())
}

#[tauri::command]
pub fn read_rapid_triggers(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    ids: Vec<u16>,
) -> Result<Vec<RapidTrigger>, String> {
    with_device(&state, |d| d.read_rapid_triggers(layer, system, &ids))
}

#[tauri::command]
pub fn write_rapid_triggers(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    list: Vec<RapidTrigger>,
) -> Result<(), String> {
    with_device(&state, |d| d.write_rapid_triggers(layer, system, &list))
}

#[tauri::command]
pub fn read_key_travel(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    ids: Vec<u16>,
) -> Result<Vec<KeyTravel>, String> {
    with_device(&state, |d| d.read_key_travel(layer, system, &ids))
}

#[tauri::command]
pub fn write_key_travel(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    list: Vec<KeyTravel>,
) -> Result<(), String> {
    with_device(&state, |d| d.write_key_travel(layer, system, &list))
}

#[tauri::command]
pub fn read_switch_types(
    state: tauri::State<'_, AppState>,
    ids: Vec<u16>,
) -> Result<Vec<SwitchType>, String> {
    with_device(&state, |d| d.read_switch_types(&ids))
}

#[tauri::command]
pub fn write_switch_types(
    state: tauri::State<'_, AppState>,
    list: Vec<SwitchType>,
) -> Result<(), String> {
    with_device(&state, |d| d.write_switch_types(&list))
}

#[tauri::command]
pub fn read_safe_area(
    state: tauri::State<'_, AppState>,
    ids: Vec<u16>,
) -> Result<Vec<SafeArea>, String> {
    with_device(&state, |d| d.read_safe_area(&ids))
}

#[tauri::command]
pub fn write_safe_area(
    state: tauri::State<'_, AppState>,
    list: Vec<SafeArea>,
) -> Result<(), String> {
    with_device(&state, |d| d.write_safe_area(&list))
}

#[tauri::command]
pub fn read_ad_range(
    state: tauri::State<'_, AppState>,
    ids: Vec<u16>,
) -> Result<Vec<AdRange>, String> {
    with_device(&state, |d| d.read_ad_range(&ids))
}

#[tauri::command]
pub fn start_calibration(state: tauri::State<'_, AppState>) -> Result<(), String> {
    with_device(&state, |d| d.start_calibration())
}

#[tauri::command]
pub fn stop_calibration(state: tauri::State<'_, AppState>) -> Result<(), String> {
    with_device(&state, |d| d.stop_calibration())
}

#[tauri::command]
pub fn start_travel_monitor(state: tauri::State<'_, AppState>, ids: Vec<u16>) -> Result<(), String> {
    with_device(&state, |d| d.start_travel_monitor(&ids))
}

#[tauri::command]
pub fn stop_travel_monitor(state: tauri::State<'_, AppState>) -> Result<(), String> {
    with_device(&state, |d| d.stop_travel_monitor())
}

/// Re-arm the monitor for `ids` and return what arrived during `timeout_ms`.
/// The UI calls this once per tick — the device stops streaming otherwise.
#[tauri::command]
pub fn poll_travel_monitor(
    state: tauri::State<'_, AppState>,
    ids: Vec<u16>,
    timeout_ms: u64,
) -> Result<TriggerEvents, String> {
    with_device(&state, |d| {
        let (travel, calibration) = d.poll_travel_monitor(&ids, timeout_ms.min(2000))?;
        Ok(TriggerEvents { travel, calibration })
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct TriggerEvents {
    pub travel: Vec<TravelSample>,
    pub calibration: Vec<CalibrationSample>,
}

#[tauri::command]
pub fn read_trigger_events(
    state: tauri::State<'_, AppState>,
    timeout_ms: u64,
) -> Result<TriggerEvents, String> {
    with_device(&state, |d| {
        let (travel, calibration) = d.read_trigger_events(timeout_ms.min(2000))?;
        Ok(TriggerEvents { travel, calibration })
    })
}

/// Reports dropped because the consumer fell behind (`MAX_QUEUED_REPORTS`).
/// Non-zero almost always means the window was hidden/minimised, where the
/// webview throttles `setTimeout` to ~1 Hz — the queue is bounded on purpose so
/// that can never grow without limit.
#[tauri::command]
pub fn dropped_reports(state: tauri::State<'_, AppState>) -> Result<u64, String> {
    with_device(&state, |d| Ok(d.dropped_reports()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_layouts() {
        let d = [0x00, 0x2A, 0x01, 0x00, 0x0D, 0x00, 0x46, 0x00];
        let rt = [RapidTrigger {
            id: be16(&d, 0),
            enable: d[2],
            press: be16(&d, 3),
            release: be16(&d, 5),
        }];
        assert_eq!(rt[0], RapidTrigger { id: 42, enable: 1, press: 13, release: 70 });

        let s = SafeArea { id: 1, top: 26, bottom: 70, enable: 1 };
        let mut buf = Vec::new();
        buf.extend_from_slice(&s.id.to_be_bytes());
        buf.extend_from_slice(&s.top.to_be_bytes());
        buf.extend_from_slice(&s.bottom.to_be_bytes());
        buf.push(0);
        buf.push(s.enable);
        assert_eq!(buf, vec![0x00, 0x01, 0x00, 0x1a, 0x00, 0x46, 0x00, 0x01]);
        assert_eq!(be16(&buf, 2), 26);
        assert_eq!(be16(&buf, 4), 70);
        assert_eq!(buf[7], 1);
    }

    #[test]
    fn travel_sample_split() {
        let f: u16 = 0x25D8;
        assert!(!(f & 0x8000 != 0));
        assert_eq!(f & 0x7FFF, 0x25D8);
        let f2: u16 = 0xA5D8;
        assert!(f2 & 0x8000 != 0);
        assert_eq!(f2 & 0x7FFF, 0x25D8);
    }

    #[test]
    fn calibration_bit15_means_finished() {
        // Real capture: 94 02 00 01 00 06 | 00 01 85 68 05 65
        // id=1, field=0x8568 -> bit15 set -> finished, ad=0x0568, min=0x0565.
        let rec = [0x00u8, 0x01, 0x85, 0x68, 0x05, 0x65];
        let f = be16(&rec, 2);
        assert_eq!(be16(&rec, 0), 1);
        assert!(f & 0x8000 != 0, "bit15 set must mean finished");
        assert_eq!(f & 0x7FFF, 0x0568);
        assert_eq!(be16(&rec, 4), 0x0565);

        // bit15 clear -> not finished yet.
        let rec2 = [0x00u8, 0x02, 0x05, 0x68, 0x05, 0x65];
        let f2 = be16(&rec2, 2);
        assert!(f2 & 0x8000 == 0);
        assert_eq!(f2 & 0x7FFF, 0x0568);
    }
}
