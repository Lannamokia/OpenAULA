//! Macro service (docs/commands.md §5).
//!
//! Region layout: `[header table][bodies…]`
//!   - header entry = 4 bytes **little-endian** `{ offset LE16, length LE16 }`,
//!     offsets measured from the start of the region; the first entry's offset
//!     equals `4 × macroCount` (i.e. the header table length).
//!   - body = `[nameLen][UTF-8 name][action × N]`
//!   - action = 4 bytes
//!     `[((kind&1)<<7)|((device&7)<<4)|((delay>>16)&15), (delay>>8)&255, delay&255, keycode]`
//!
//! ⚠ The device erases everything **beyond the written length** (0xff). We always
//! write the complete set (header + every body) and only ever after a full read,
//! so nothing outside the set can be lost. See `docs/commands.md` §5 for the
//! incident this rule comes from.

use serde::{Deserialize, Serialize};

use crate::commands::{with_device, AppState};
use crate::proto::{build_app_packet, build_packets};
use crate::service::AulaDevice;

pub const CMD_MACRO_R: u8 = 0x85;
pub const CMD_MACRO_W: u8 = 0x05;
pub const CMD_CAP_MACRO: u8 = 0x82;

/// Fallback region size when `0x82/0` cannot be read (measured value).
const DEFAULT_CAPACITY: u32 = 4096;
/// Per-packet payload used by both macro directions (SDK `buildMacroCommands`).
const MACRO_PER_PACKET: usize = 56;

/// One macro action (4 bytes on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacroAction {
    /// bit7 of byte 0: `0` = 按下, `1` = 抬起.
    pub kind: u8,
    /// bits 4..6 of byte 0: `0` = 键盘, `1` = 鼠标, `2` = 多媒体.
    pub device: u8,
    /// 20-bit delay in milliseconds (`0..=0xFFFFF`).
    pub delay: u32,
    /// 1-byte keycode.
    pub keycode: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Macro {
    pub name: String,
    pub actions: Vec<MacroAction>,
}

/// Parsed macro region, plus the raw bytes so the UI can show what was read.
#[derive(Debug, Clone, Serialize)]
pub struct MacroRegion {
    /// `0x82/0` — macro storage size in bytes.
    pub capacity: u32,
    /// Bytes actually read back from the region.
    pub total_len: usize,
    /// `0x85/0` header-table length (0 / 0xffff = no macros).
    pub header_len: usize,
    pub macros: Vec<Macro>,
    /// Every `0xff` = erased region.
    pub empty: bool,
    pub raw: String,
}

fn decode_action(b: [u8; 4]) -> MacroAction {
    MacroAction {
        kind: (b[0] >> 7) & 1,
        device: (b[0] >> 4) & 7,
        delay: (((b[0] & 0x0F) as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32,
        keycode: b[3],
    }
}

fn encode_action(a: &MacroAction) -> [u8; 4] {
    let d = a.delay & 0x000F_FFFF;
    [
        ((a.kind & 1) << 7) | ((a.device & 7) << 4) | (((d >> 16) as u8) & 0x0F),
        ((d >> 8) & 0xFF) as u8,
        (d & 0xFF) as u8,
        a.keycode,
    ]
}

/// Parse the header table: entry = 4 bytes LE `{offset, length}`.
///
/// The table length is not stored anywhere we can query reliably (`0x85/0` with a
/// 2-byte request returns nothing useful on this firmware), so we derive it from
/// the first entry's offset — which the SDK always sets to `4 × macroCount`.
fn parse_header(region: &[u8]) -> (usize, Vec<(usize, usize)>) {
    if region.len() < 4 {
        return (0, Vec::new());
    }
    let first = u16::from_le_bytes([region[0], region[1]]) as usize;
    if first == 0xFFFF || first == 0 || first % 4 != 0 || first > region.len() {
        return (0, Vec::new());
    }
    let mut entries = Vec::with_capacity(first / 4);
    for i in 0..first / 4 {
        let p = i * 4;
        let off = u16::from_le_bytes([region[p], region[p + 1]]) as usize;
        let len = u16::from_le_bytes([region[p + 2], region[p + 3]]) as usize;
        if off == 0xFFFF || len == 0 || off + len > region.len() {
            break;
        }
        entries.push((off, len));
    }
    (first, entries)
}

/// Split the bodies out of a region using an already-parsed header table.
fn parse_bodies(region: &[u8], entries: &[(usize, usize)]) -> Vec<Macro> {
    let mut out = Vec::with_capacity(entries.len());
    for &(off, len) in entries {
        let body = &region[off..off + len];
        let name_len = body[0] as usize;
        if 1 + name_len > body.len() {
            break;
        }
        let name = String::from_utf8_lossy(&body[1..1 + name_len]).to_string();
        let actions = body[1 + name_len..]
            .chunks_exact(4)
            .map(|c| decode_action([c[0], c[1], c[2], c[3]]))
            .collect();
        out.push(Macro { name, actions });
    }
    out
}

/// Serialise macros into `[header table][bodies]` (no trailing pad — the device
/// erases whatever follows, which is exactly the end state we want).
fn build_region(macros: &[Macro]) -> Result<Vec<u8>, String> {
    let header_len = macros.len() * 4;
    let mut header = Vec::with_capacity(header_len);
    let mut bodies = Vec::new();
    let mut cursor = header_len;
    for m in macros {
        let name = m.name.as_bytes();
        if name.len() > 255 {
            return Err(format!("宏名过长（{} 字节，上限 255）", name.len()));
        }
        let mut body = Vec::with_capacity(1 + name.len() + m.actions.len() * 4);
        body.push(name.len() as u8);
        body.extend_from_slice(name);
        for a in &m.actions {
            body.extend_from_slice(&encode_action(a));
        }
        header.extend_from_slice(&(cursor as u16).to_le_bytes());
        header.extend_from_slice(&(body.len() as u16).to_le_bytes());
        cursor += body.len();
        bodies.extend_from_slice(&body);
    }
    let mut out = header;
    out.extend_from_slice(&bodies);
    Ok(out)
}

impl AulaDevice {
    /// `0x82/0` — macro storage capacity in bytes (4 bytes big-endian).
    pub fn macro_capacity(&self) -> u32 {
        let d = match self.read_cmd(CMD_CAP_MACRO, 0x00, 4) {
            Ok(d) => d,
            Err(_) => return DEFAULT_CAPACITY,
        };
        let v = u32::from_be_bytes([d[0], d[1], d[2], d[3]]);
        if v == 0 {
            DEFAULT_CAPACITY
        } else {
            v
        }
    }

    /// `0x85/0` read of the macro region (offset injection included).
    ///
    /// Read in two steps: probe the head to learn the header-table length (the
    /// first entry's offset), then read exactly as far as the last body reaches.
    /// Reading the whole 4 KiB capacity on every refresh would be 74 round trips.
    pub fn read_macros(&self) -> Result<MacroRegion, String> {
        let capacity = self.macro_capacity() as usize;
        let probe = capacity.min(256);
        let mut region = self.read_macro_region(probe)?;

        let first = if region.len() >= 4 {
            u16::from_le_bytes([region[0], region[1]]) as usize
        } else {
            0
        };
        if first != 0xFFFF && first != 0 && first % 4 == 0 && first > region.len() {
            region = self.read_macro_region(first.min(capacity))?;
        }

        let (_header_len, entries) = parse_header(&region);
        let need = entries
            .iter()
            .map(|(o, l)| o + l)
            .max()
            .unwrap_or(0);
        if need > region.len() {
            region = self.read_macro_region(need.min(capacity))?;
        }

        let (header_len, entries) = parse_header(&region);
        let empty = region.iter().all(|&b| b == 0xFF);
        let macros = if empty { Vec::new() } else { parse_bodies(&region, &entries) };
        Ok(MacroRegion {
            capacity: capacity as u32,
            total_len: region.len(),
            header_len,
            macros,
            empty,
            raw: crate::commands::hex(&region),
        })
    }

    /// Replace the whole macro set (`0x05/0`, no offset injection).
    pub fn write_macros(&self, macros: &[Macro]) -> Result<usize, String> {
        let region = build_region(macros)?;
        let capacity = self.macro_capacity() as usize;
        if region.len() > capacity {
            return Err(format!(
                "宏区超限：需要 {} 字节，容量 {} 字节",
                region.len(),
                capacity
            ));
        }
        for p in build_packets(CMD_MACRO_W, 0x00, &region, MACRO_PER_PACKET) {
            self.exchange(&p)?;
        }
        Ok(region.len())
    }
}

#[tauri::command]
pub fn read_macro_capacity(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    with_device(&state, |d| Ok(d.macro_capacity()))
}

/// Read the whole macro set + the raw region bytes.
#[tauri::command]
pub fn read_macro_set(state: tauri::State<'_, AppState>) -> Result<MacroRegion, String> {
    with_device(&state, |d| d.read_macros())
}

/// Replace the whole macro set. Returns the number of bytes written.
#[tauri::command]
pub fn write_macro_set(
    state: tauri::State<'_, AppState>,
    macros: Vec<Macro>,
) -> Result<usize, String> {
    with_device(&state, |d| d.write_macros(&macros))
}

/// Raw one-shot read for the debug page (hex of the whole region).
#[tauri::command]
pub fn read_macro_raw(
    state: tauri::State<'_, AppState>,
    total_len: usize,
) -> Result<String, String> {
    with_device(&state, |d| {
        d.read_macro_region(total_len).map(|v| crate::commands::hex(&v))
    })
}

/// Build the packets for a macro set without sending them (protocol debugging).
pub fn build_macro_packets_debug(macros: &[Macro]) -> Result<Vec<String>, String> {
    let region = build_region(macros)?;
    Ok(build_packets(CMD_MACRO_W, 0, &region, MACRO_PER_PACKET)
        .iter()
        .map(|p| crate::commands::hex(p))
        .collect())
}

/// Build a single request packet (used by tests / debug helpers).
pub fn build_macro_read_packet() -> String {
    crate::commands::hex(&build_app_packet(CMD_MACRO_R, 0x00, &[]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn act(kind: u8, device: u8, delay: u32, keycode: u8) -> MacroAction {
        MacroAction { kind, device, delay, keycode }
    }

    #[test]
    fn action_roundtrip() {
        for a in [
            act(0, 0, 0, 0x04),
            act(1, 0, 100, 0x04),
            act(0, 1, 0xFFFFF, 0xFF),
            act(1, 2, 0x12345, 0x00),
        ] {
            assert_eq!(decode_action(encode_action(&a)), a);
        }
    }

    #[test]
    fn region_roundtrip() {
        let macros = vec![
            Macro {
                name: "M1".into(),
                actions: vec![act(0, 0, 0, 0x04), act(1, 0, 50, 0x04)],
            },
            Macro {
                name: "组合".into(),
                actions: vec![act(0, 0, 10, 0xE0)],
            },
        ];
        let region = build_region(&macros).unwrap();
        // header: 2 entries -> first body at offset 8
        assert_eq!(
            u16::from_le_bytes([region[0], region[1]]),
            8,
            "first body offset must equal the header table length"
        );
        // macro 1 body = 1 nameLen + 2 name bytes + 2 actions * 4
        assert_eq!(u16::from_le_bytes([region[2], region[3]]) as usize, 1 + 2 + 8);
        // macro 2 body = 1 nameLen + 6 name bytes ("组合" is 6 bytes UTF-8) + 1 action * 4
        assert_eq!(u16::from_le_bytes([region[6], region[7]]) as usize, 1 + 6 + 4);
        let parsed = parse_header(&region);
        assert_eq!(parsed.0, 8, "header table length = 4 × macroCount");
        assert_eq!(parse_bodies(&region, &parsed.1), macros);
    }

    #[test]
    fn encode_matches_documentation() {
        // ((kind&1)<<7)|((device&7)<<4)|((delay>>16)&15), delay>>8, delay&255, keycode
        let a = act(1, 2, 0x0ABCD, 0x29);
        assert_eq!(encode_action(&a), [0xA0, 0xAB, 0xCD, 0x29]);
    }
}
