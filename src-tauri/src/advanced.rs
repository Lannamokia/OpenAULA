//! Advanced-key service (docs/commands.md §6).
//!
//! Seven types, all written through `0x12` with the type injected into packet
//! byte `[2]` after the packets are built (`inject_advanced_type`), and read
//! back through `0x92` (list = empty data, detail = `BE16(id)`; the reply carries
//! the type in packet byte `[2]` and starts its data area with `BE16(id)`).
//!
//! | kind | name | layout |
//! |---|---|---|
//! | 1 | TGL  | `BE16(id) + BE32(keycode) + BE16(delay)` = 8 |
//! | 2 | MT   | `BE16(id) + BE32(hold) + BE32(click) + BE16(delay)` = 12 |
//! | 3 | DKS  | `BE16(id) + 4×BE16(depth) + N×(BE32(keycode) + 4×1B trigger)` |
//! | 4 | SOCD | `[count] + count×BE16(id) + responseMode` |
//! | 5 | MPT  | `BE16(id) + [count] + N×(BE32(keycode) + BE16(distance))` |
//! | 6 | END  | `BE16(id) + BE32(keycode)` = 6 |
//! | 7 | RS   | `2×BE16(id)` = 4 |

use serde::{Deserialize, Serialize};

use crate::commands::{hex, with_device, AppState};
use crate::proto::{build_app_packet, build_packets, els, inject_advanced_type};
use crate::service::AulaDevice;

pub const CMD_ADV_R: u8 = 0x92;
pub const CMD_ADV_W: u8 = 0x12;

pub const KIND_TGL: u8 = 1;
pub const KIND_MT: u8 = 2;
pub const KIND_DKS: u8 = 3;
pub const KIND_SOCD: u8 = 4;
pub const KIND_MPT: u8 = 5;
pub const KIND_END: u8 = 6;
pub const KIND_RS: u8 = 7;
pub const KIND_NONE: u8 = 0;

/// (kind, UI 名称) — order matches the official page's cards.
pub const KIND_NAMES: [(u8, &str); 7] = [
    (KIND_TGL, "切换开关 (TGL)"),
    (KIND_MT, "按住/单击 (MT)"),
    (KIND_DKS, "动态键程 (DKS)"),
    (KIND_SOCD, "瞬间释放 (SOCD)"),
    (KIND_MPT, "多点触控 (MPT)"),
    (KIND_END, "终端跃迁 (END)"),
    (KIND_RS, "迅捷 (RS)"),
];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdvancedGroup {
    pub keycode: u32,
    /// MPT only: distance in 0.01 mm units (`UI mm × 100`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance: Option<u16>,
    /// DKS only: the 4 trigger-segment bytes (enum values, passed through).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<u8>>,
}

/// One advanced-key record. Which fields matter depends on `kind`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdvancedKey {
    /// 0 = 空槽（NONE）, 1..7 = TGL/MT/DKS/SOCD/MPT/END/RS.
    pub kind: u8,
    pub id: u16,
    /// SOCD (2 ids) / RS (2 ids).
    #[serde(default)]
    pub ids: Vec<u16>,
    /// TGL / END.
    #[serde(default)]
    pub keycode: u32,
    /// MT.
    #[serde(default)]
    pub hold_keycode: u32,
    /// MT.
    #[serde(default)]
    pub click_keycode: u32,
    /// TGL / MT, milliseconds.
    #[serde(default)]
    pub delay: u16,
    /// DKS: 4 press depths (0.01 mm units).
    #[serde(default)]
    pub depths: Vec<u16>,
    /// DKS / MPT.
    #[serde(default)]
    pub groups: Vec<AdvancedGroup>,
    /// SOCD response mode (0 = 默认).
    #[serde(default)]
    pub response_mode: u8,
}

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

/// Serialise the type-specific body (`docs/commands.md` §6).
pub fn build_advanced(k: &AdvancedKey) -> Result<Vec<u8>, String> {
    let mut d = Vec::new();
    d.extend_from_slice(&k.id.to_be_bytes());
    match k.kind {
        KIND_TGL => {
            put_u32(&mut d, k.keycode);
            d.extend_from_slice(&k.delay.to_be_bytes());
        }
        KIND_MT => {
            put_u32(&mut d, k.hold_keycode);
            put_u32(&mut d, k.click_keycode);
            d.extend_from_slice(&k.delay.to_be_bytes());
        }
        KIND_DKS => {
            if k.depths.len() != 4 {
                return Err("DKS 需要 4 个 press depth".into());
            }
            for v in &k.depths {
                d.extend_from_slice(&v.to_be_bytes());
            }
            for g in &k.groups {
                put_u32(&mut d, g.keycode);
                let t = g.triggers.clone().unwrap_or_else(|| vec![0, 0, 0, 0]);
                if t.len() != 4 {
                    return Err("DKS 每组的 trigger 必须是 4 字节".into());
                }
                d.extend_from_slice(&t);
            }
        }
        KIND_SOCD => {
            if k.ids.is_empty() || k.ids.len() > 255 {
                return Err("SOCD 需要 1..255 个 id".into());
            }
            d.clear(); // SOCD 的 data 不以本键 id 开头
            d.push(k.ids.len() as u8);
            for id in &k.ids {
                d.extend_from_slice(&id.to_be_bytes());
            }
            d.push(k.response_mode);
        }
        KIND_MPT => {
            d.push(k.groups.len() as u8);
            for g in &k.groups {
                put_u32(&mut d, g.keycode);
                d.extend_from_slice(&g.distance.unwrap_or(0).to_be_bytes());
            }
        }
        KIND_END => {
            put_u32(&mut d, k.keycode);
        }
        KIND_RS => {
            if k.ids.len() != 2 {
                return Err("RS 需要恰好 2 个 id".into());
            }
            d.clear();
            for id in &k.ids {
                d.extend_from_slice(&id.to_be_bytes());
            }
        }
        other => return Err(format!("未知的高级键类型 {other}")),
    }
    Ok(d)
}

fn be16(d: &[u8], p: usize) -> u16 {
    u16::from_be_bytes([d[p], d[p + 1]])
}

/// Parse a detail reply's data area (which starts with `BE16(id)`).
pub fn parse_advanced(kind: u8, data: &[u8]) -> Result<AdvancedKey, String> {
    if data.len() < 2 {
        return Err("应答数据过短".into());
    }
    let id = be16(data, 0);
    let mut k = AdvancedKey { kind, id, ..Default::default() };
    let b = &data[2..];
    match kind {
        KIND_TGL => {
            if b.len() < 6 {
                return Err("TGL 数据过短".into());
            }
            k.keycode = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
            k.delay = be16(b, 4);
        }
        KIND_MT => {
            if b.len() < 10 {
                return Err("MT 数据过短".into());
            }
            k.hold_keycode = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
            k.click_keycode = u32::from_be_bytes([b[4], b[5], b[6], b[7]]);
            k.delay = be16(b, 8);
        }
        KIND_DKS => {
            if b.len() < 8 {
                return Err("DKS 数据过短".into());
            }
            k.depths = (0..4).map(|i| be16(b, i * 2)).collect();
            let mut p = 8;
            while p + 8 <= b.len() {
                k.groups.push(AdvancedGroup {
                    keycode: u32::from_be_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]),
                    distance: None,
                    triggers: Some(b[p + 4..p + 8].to_vec()),
                });
                p += 8;
            }
        }
        KIND_SOCD => {
            let count = data[0] as usize;
            let mut p = 1;
            for _ in 0..count {
                if p + 2 > data.len() {
                    break;
                }
                k.ids.push(be16(data, p));
                p += 2;
            }
            k.id = *k.ids.first().unwrap_or(&0);
            k.response_mode = data.get(p).copied().unwrap_or(0);
        }
        KIND_MPT => {
            if b.is_empty() {
                return Err("MPT 数据过短".into());
            }
            let count = b[0] as usize;
            let mut p = 1;
            for _ in 0..count {
                if p + 6 > b.len() {
                    break;
                }
                k.groups.push(AdvancedGroup {
                    keycode: u32::from_be_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]),
                    distance: Some(be16(b, p + 4)),
                    triggers: None,
                });
                p += 6;
            }
        }
        KIND_END => {
            if b.len() < 4 {
                return Err("END 数据过短".into());
            }
            k.keycode = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
        }
        KIND_RS => {
            // data = 2×BE16(id)；本键 id 就是第一个
            k.ids = data.chunks_exact(2).take(2).map(|c| be16(c, 0)).collect();
            k.id = *k.ids.first().unwrap_or(&0);
        }
        _ => return Err(format!("未知的高级键类型 {kind}")),
    }
    Ok(k)
}

impl AulaDevice {
    /// `0x92` empty data — every advanced-key slot id on `layer`/`system`.
    pub fn advanced_ids(&self, layer: u8, system: u8) -> Result<Vec<u16>, String> {
        let pkt = build_app_packet(CMD_ADV_R, els(layer, system), &[]);
        let r = self.exchange(&pkt)?.ok_or("no reply (timeout)")?;
        // The SDK trusts the reply's own length byte here (see commands.md §6).
        let len = (r[5] as usize).min(56);
        Ok(r[6..6 + len]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect())
    }

    /// `0x92` with `BE16(id)` — one advanced key. `None` when the slot is empty.
    pub fn advanced_get(
        &self,
        layer: u8,
        system: u8,
        id: u16,
    ) -> Result<Option<(u8, Vec<u8>)>, String> {
        let pkt = build_app_packet(CMD_ADV_R, els(layer, system), &id.to_be_bytes());
        let r = self.exchange(&pkt)?.ok_or("no reply (timeout)")?;
        let kind = r[2];
        if kind == 0 || kind == 0xFF {
            return Ok(None);
        }
        Ok(Some((kind, r[6..62].to_vec())))
    }

    /// `0x12` with the type injected into `[2]`.
    pub fn advanced_set(&self, layer: u8, system: u8, k: &AdvancedKey) -> Result<(), String> {
        let data = build_advanced(k)?;
        let mut pkts = build_packets(CMD_ADV_W, els(layer, system), &data, 56);
        inject_advanced_type(&mut pkts, k.kind);
        for p in &pkts {
            self.send_command(p)?;
        }
        Ok(())
    }

    /// Delete = same command with type injected as 0 (NONE).
    pub fn advanced_delete(&self, layer: u8, system: u8, id: u16) -> Result<(), String> {
        let mut pkts = build_packets(CMD_ADV_W, els(layer, system), &id.to_be_bytes(), 56);
        inject_advanced_type(&mut pkts, KIND_NONE);
        for p in &pkts {
            self.send_command(p)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AdvancedEntry {
    pub id: u16,
    /// `None` = 空槽（已分配 id 但类型为 NONE）.
    pub key: Option<AdvancedKey>,
}

/// List every advanced-key slot on a layer with its detail (best effort: a slot
/// that answers with kind 0 is reported as an empty entry rather than an error).
pub fn read_all(d: &AulaDevice, layer: u8, system: u8) -> Result<Vec<AdvancedEntry>, String> {
    let ids = d.advanced_ids(layer, system)?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        match d.advanced_get(layer, system, id) {
            Ok(Some((kind, data))) => match parse_advanced(kind, &data) {
                Ok(key) => out.push(AdvancedEntry { id, key: Some(key) }),
                Err(_) => out.push(AdvancedEntry { id, key: None }),
            },
            _ => out.push(AdvancedEntry { id, key: None }),
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn read_advanced_ids(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
) -> Result<Vec<u16>, String> {
    with_device(&state, |d| d.advanced_ids(layer, system))
}

#[tauri::command]
pub fn read_advanced(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
) -> Result<Vec<AdvancedEntry>, String> {
    with_device(&state, |d| read_all(d, layer, system))
}

#[tauri::command]
pub fn read_advanced_key(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    id: u16,
) -> Result<Option<AdvancedKey>, String> {
    with_device(&state, |d| match d.advanced_get(layer, system, id)? {
        Some((kind, data)) => Ok(Some(parse_advanced(kind, &data)?)),
        None => Ok(None),
    })
}

#[tauri::command]
pub fn set_advanced_key(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    key: AdvancedKey,
) -> Result<(), String> {
    with_device(&state, |d| d.advanced_set(layer, system, &key))
}

#[tauri::command]
pub fn delete_advanced_key2(
    state: tauri::State<'_, AppState>,
    layer: u8,
    system: u8,
    id: u16,
) -> Result<(), String> {
    with_device(&state, |d| d.advanced_delete(layer, system, id))
}

/// Encode a spec to hex without touching the device (UI preview / debugging).
#[tauri::command]
pub fn preview_advanced(key: AdvancedKey) -> Result<String, String> {
    build_advanced(&key).map(|d| hex(&d))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tgl_roundtrip() {
        let k = AdvancedKey { kind: KIND_TGL, id: 42, keycode: 0x29, delay: 200, ..Default::default() };
        let d = build_advanced(&k).unwrap();
        assert_eq!(d.len(), 8);
        assert_eq!(d, vec![0x00, 0x2A, 0x00, 0x00, 0x00, 0x29, 0x00, 0xC8]);
        assert_eq!(parse_advanced(KIND_TGL, &d).unwrap(), k);
    }

    #[test]
    fn mt_roundtrip() {
        let k = AdvancedKey {
            kind: KIND_MT, id: 7, hold_keycode: 0x04, click_keycode: 0x05, delay: 150,
            ..Default::default()
        };
        let d = build_advanced(&k).unwrap();
        assert_eq!(d.len(), 12);
        assert_eq!(parse_advanced(KIND_MT, &d).unwrap(), k);
    }

    #[test]
    fn end_and_rs_and_socd() {
        let e = AdvancedKey { kind: KIND_END, id: 3, keycode: 0x2C, ..Default::default() };
        assert_eq!(build_advanced(&e).unwrap().len(), 6);
        assert_eq!(parse_advanced(KIND_END, &build_advanced(&e).unwrap()).unwrap(), e);

        let r = AdvancedKey { kind: KIND_RS, ids: vec![1, 2], id: 1, ..Default::default() };
        assert_eq!(build_advanced(&r).unwrap(), vec![0x00, 0x01, 0x00, 0x02]);

        let s = AdvancedKey {
            kind: KIND_SOCD, ids: vec![1, 28, 42], response_mode: 1, id: 1, ..Default::default()
        };
        let d = build_advanced(&s).unwrap();
        assert_eq!(d, vec![0x03, 0x00, 0x01, 0x00, 0x1C, 0x00, 0x2A, 0x01]);
        assert_eq!(parse_advanced(KIND_SOCD, &d).unwrap(), s);
    }

    #[test]
    fn dks_and_mpt() {
        let k = AdvancedKey {
            kind: KIND_DKS,
            id: 5,
            depths: vec![13, 35, 50, 70],
            groups: vec![
                AdvancedGroup { keycode: 0x04, triggers: Some(vec![1, 2, 3, 4]), distance: None },
                AdvancedGroup { keycode: 0x05, triggers: Some(vec![0, 0, 0, 0]), distance: None },
            ],
            ..Default::default()
        };
        let d = build_advanced(&k).unwrap();
        assert_eq!(d.len(), 2 + 8 + 2 * 8);
        assert_eq!(parse_advanced(KIND_DKS, &d).unwrap(), k);

        let m = AdvancedKey {
            kind: KIND_MPT,
            id: 9,
            groups: vec![
                AdvancedGroup { keycode: 0x04, distance: Some(13), triggers: None },
                AdvancedGroup { keycode: 0x05, distance: Some(35), triggers: None },
                AdvancedGroup { keycode: 0x06, distance: Some(70), triggers: None },
            ],
            ..Default::default()
        };
        let d = build_advanced(&m).unwrap();
        assert_eq!(d.len(), 2 + 1 + 3 * 6);
        assert_eq!(parse_advanced(KIND_MPT, &d).unwrap(), m);
    }
}
