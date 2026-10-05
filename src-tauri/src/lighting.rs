//! Lighting service + commands (docs/commands.md §4). Zones are addressed by a
//! per-zone param base: Main=1 / Side=6 / Logo=11 / Lightbox=35, with
//! `base+0` = whole-block read/write, `+1..+4` = effect id / color /
//! brightness / speed. Protocol ranges: brightness 0..21, speed 0..5,
//! colorIndex 0..6 fixed / 7 = random (multi-color).

use serde::{Deserialize, Serialize};

use crate::commands::{hex, with_device, AppState};
use crate::proto::{build_app_packet, build_packets, build_raw_reports};
use crate::service::AulaDevice;

pub const CMD_LIGHTING_R: u8 = 0x84;
pub const CMD_LIGHTING_W: u8 = 0x04;
pub const CMD_CAP_LIGHTING: u8 = 0x82;
pub const CMD_RGB_W: u8 = crate::proto::CMD_RGB;
pub const CMD_LIGHTBOX_W: u8 = 0x29;
pub const CMD_CUSTOM_R: u8 = 0x86;
pub const CMD_CUSTOM_W: u8 = 0x06;

/// 无线裸报文的灯光子类型（`(type<<4)|len` 的高 4 位）。取值与
/// `0x08/<param>` 的应用包一一对应，SDK 的 `*ByWireless` 方法按同样的 type 区分。
pub const RAW_TYPE_KEY: u8 = 0x01; // updateRGBByWireless
pub const RAW_TYPE_FULL: u8 = 0x02; // updateFullKeysRGBByWireless
pub const RAW_TYPE_BEADS: u8 = 0x03; // updateRGBWithLedBeadsByWireless

pub const BASE_MAIN: u8 = 1;
pub const BASE_SIDE: u8 = 6;
pub const BASE_LOGO: u8 = 11;
pub const BASE_LIGHTBOX: u8 = 35;

/// (base, 区域名) — order matches the UI tabs.
pub const ZONES: [(u8, &str); 4] = [
    (BASE_MAIN, "主灯"),
    (BASE_SIDE, "侧灯"),
    (BASE_LOGO, "Logo"),
    (BASE_LIGHTBOX, "灯箱"),
];

/// `updateRGB` total payload limit (docs/commands.md §4.3).
const RGB_PAYLOAD_MAX: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneEffect {
    /// 0..18 preset, 19 = custom.
    pub effect_id: u8,
    /// 0..6 fixed color, 7 = random (multi-color).
    pub color_index: u8,
    pub color: Rgb,
    /// Protocol range 0..21 (UI shows 1..22).
    pub brightness: u8,
    /// Protocol range 0..5 (UI shows 1..6).
    pub speed: u8,
    /// Only meaningful for the main zone when the device supports it.
    pub direction: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyColor {
    pub id: u16,
    pub color: Rgb,
}

#[derive(Debug, Clone, Serialize)]
pub struct LightingCaps {
    pub music_main: bool,
    pub music_spectrum: bool,
    pub music_side: bool,
    /// Non-zero = side light zone exists.
    pub side_light: bool,
    /// Side-light LED bead count (`[20]`).
    pub side_beads: u8,
    pub logo_light: bool,
    pub lightbox_rows: u16,
    pub lightbox_cols: u16,
    /// Bit i set => effect id (i+1) supported.
    pub effect_bitmap: u8,
    /// From the device-feature block (`0x82/0x0f` `[16]`), 1 = supported.
    pub direction_supported: bool,
    /// Raw `0x82/0x09` data area, for the debug readout.
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZoneState {
    pub base: u8,
    pub name: &'static str,
    pub supported: bool,
    /// None when unsupported or unreadable (see `error`).
    pub effect: Option<ZoneEffect>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LightingOverview {
    /// None when the capability read itself failed (device may still answer
    /// zone reads; the UI falls back to those).
    pub caps: Option<LightingCaps>,
    pub zones: Vec<ZoneState>,
}

fn rgb565_be(c: &Rgb) -> [u8; 2] {
    let v = (((c.r >> 3) as u16) << 11) | (((c.g >> 2) as u16) << 5) | ((c.b >> 3) as u16);
    v.to_be_bytes()
}

/// Squared euclidean distance between two colors (0..=3*255^2).
fn color_dist(a: &Rgb, b: &Rgb) -> u32 {
    let d = |x: u8, y: u8| (x as i32 - y as i32) * (x as i32 - y as i32);
    (d(a.r, b.r) + d(a.g, b.g) + d(a.b, b.b)) as u32
}

/// One color cluster: its (possibly merged) color plus member key ids.
struct ColorGroup {
    color: Rgb,
    ids: Vec<u8>,
}

impl ColorGroup {
    fn payload_len(&self) -> usize {
        4 + self.ids.len()
    }

    /// Weighted average of two clusters (docs/commands.md §4.3: 簇内取平均值).
    fn merge(&mut self, other: ColorGroup) {
        let n = self.ids.len();
        let m = other.ids.len();
        let avg = |x: u8, y: u8| ((x as u32 * n as u32 + y as u32 * m as u32) / (n + m) as u32) as u8;
        self.color = Rgb {
            r: avg(self.color.r, other.color.r),
            g: avg(self.color.g, other.color.g),
            b: avg(self.color.b, other.color.b),
        };
        self.ids.extend_from_slice(&other.ids);
    }
}

impl AulaDevice {
    /// `0x84/<base>` whole-block read: `[id, colorIndex, r, g, b, brightness,
    /// speed]`, optional 8th direction byte (main zone + device support).
    pub fn read_zone_effect(
        &self,
        base: u8,
        direction_supported: bool,
    ) -> Result<ZoneEffect, String> {
        let n = if base == BASE_MAIN && direction_supported { 8 } else { 7 };
        let d = self.read_cmd(CMD_LIGHTING_R, base, n)?;
        Ok(ZoneEffect {
            effect_id: d[0],
            color_index: d[1],
            color: Rgb { r: d[2], g: d[3], b: d[4] },
            brightness: d[5],
            speed: d[6],
            direction: if base == BASE_MAIN && direction_supported {
                Some(d[7])
            } else {
                None
            },
        })
    }

    /// `0x04/<base>` whole-block write; the direction byte is only appended
    /// for the main zone when the device supports it.
    pub fn write_zone_effect(
        &self,
        base: u8,
        e: &ZoneEffect,
        direction_supported: bool,
    ) -> Result<(), String> {
        let mut data = vec![
            e.effect_id,
            e.color_index,
            e.color.r,
            e.color.g,
            e.color.b,
            e.brightness,
            e.speed,
        ];
        if base == BASE_MAIN && direction_supported {
            data.push(e.direction.unwrap_or(0));
        }
        self.send_command(&build_app_packet(CMD_LIGHTING_W, base, &data))?;
        Ok(())
    }

    /// `0x82/0x09` lighting capability block. Note `[0..15]` are undocumented
    /// (本机实测以 `ff ff 07` 开头); only the documented offsets are decoded.
    /// Err when the device does not answer at all.
    pub fn lighting_caps(&self) -> Result<LightingCaps, String> {
        let d = self.read_cmd(CMD_CAP_LIGHTING, 0x09, 56)?;
        // Tolerate short/zero blocks (some firmware pads with zeros).
        let get = |i: usize| d.get(i).copied().unwrap_or(0);
        let f = self
            .read_cmd(CMD_CAP_LIGHTING, 0x0f, 20)
            .unwrap_or_default();
        let dir = f.get(16).copied().unwrap_or(0);
        Ok(LightingCaps {
            music_main: get(17) & 0x01 != 0,
            music_spectrum: get(17) & 0x02 != 0,
            music_side: get(17) & 0x04 != 0,
            side_light: get(18) != 0,
            side_beads: get(20),
            logo_light: get(19) != 0,
            lightbox_rows: u16::from_be_bytes([get(21), get(22)]),
            lightbox_cols: u16::from_be_bytes([get(23), get(24)]),
            effect_bitmap: get(25),
            direction_supported: dir == 1,
            raw: hex(&d),
        })
    }

    /// `0x08/2` set every key to one color.
    pub fn set_full_keys_rgb(&self, c: &Rgb) -> Result<(), String> {
        self.send_command(&build_app_packet(CMD_RGB_W, 0x02, &[c.r, c.g, c.b]))?;
        Ok(())
    }

    /// 逐键颜色 → `[r, g, b, count, ...ids]` 拼接成的数据区。两条通道共用**同一份**
    /// 编码：裸报文 type 1 的 data 与应用包 `0x08/1` 的 data 逐字节相同。
    ///
    /// ⚠ Simplified clustering vs the SDK: we first group by *exact* color,
    /// then, only if the payload exceeds 255 bytes, greedily merge the two
    /// closest groups (euclidean distance, weighted-average color) until it
    /// fits. The SDK's full version re-clusters everything when over limit;
    /// for a 68-key board this behaves the same in practice.
    fn key_color_payload(entries: &[KeyColor]) -> Result<Vec<u8>, String> {
        let mut groups: Vec<ColorGroup> = Vec::new();
        for e in entries {
            let id = u8::try_from(e.id).map_err(|_| format!("key id {} > 255", e.id))?;
            match groups.iter_mut().find(|g| g.color == e.color) {
                Some(g) => {
                    if g.ids.contains(&id) {
                        return Err(format!("duplicate key id {id}"));
                    }
                    g.ids.push(id);
                }
                None => groups.push(ColorGroup { color: e.color, ids: vec![id] }),
            }
        }
        let payload_len = |groups: &[ColorGroup]| groups.iter().map(ColorGroup::payload_len).sum::<usize>();
        while payload_len(&groups) > RGB_PAYLOAD_MAX && groups.len() > 1 {
            // Closest pair by color distance.
            let mut best: Option<(u32, usize, usize)> = None;
            for i in 0..groups.len() {
                for j in (i + 1)..groups.len() {
                    let d = color_dist(&groups[i].color, &groups[j].color);
                    if best.map(|(bd, _, _)| d < bd).unwrap_or(true) {
                        best = Some((d, i, j));
                    }
                }
            }
            let (_, i, j) = best.ok_or("clustering failed")?;
            // j > i always (pairs are i<j), so removing j leaves i intact.
            let other = groups.remove(j);
            groups[i].merge(other);
        }
        let mut data = Vec::with_capacity(payload_len(&groups));
        for g in &groups {
            if g.ids.len() > 255 {
                return Err("more than 255 keys share one color".into());
            }
            data.extend_from_slice(&[g.color.r, g.color.g, g.color.b, g.ids.len() as u8]);
            data.extend_from_slice(&g.ids);
        }
        Ok(data)
    }

    /// `0x08/1` per-key RGB，**应用包通道**。Data = groups of
    /// `[r, g, b, count, ...ids]`, ids 1 byte each, total ≤ 255 bytes.
    pub fn set_key_colors(&self, entries: &[KeyColor]) -> Result<(), String> {
        let data = Self::key_color_payload(entries)?;
        for p in build_packets(CMD_RGB_W, 0x01, &data, 56) {
            self.send_command(&p)?;
        }
        Ok(())
    }

    /// 逐键颜色 —— **无线裸报文通道**（SDK `updateRGBByWireless`）。
    ///
    /// 数据区与 `set_key_colors` 完全相同，但不再包应用信封、不再切 0x66 帧、
    /// 不等任何应答：整帧按 13 字节切成若干条 20 字节报文直接写出，发射即忘。
    /// 一帧的报文数是 `ceil(len/13)`，空帧不发（与 SDK 一致）。返回报文条数。
    pub fn set_key_colors_wireless(&self, entries: &[KeyColor]) -> Result<usize, String> {
        let data = Self::key_color_payload(entries)?;
        let reports = build_raw_reports(RAW_TYPE_KEY, &data);
        for (i, r) in reports.iter().enumerate() {
            self.send_raw_report(r).map_err(|e| {
                format!("无线裸报文第 {}/{} 条发送失败：{e}", i + 1, reports.len())
            })?;
        }
        Ok(reports.len())
    }

    /// `0x29/3` lightbox matrix: one RGB565 (big-endian) per cell, in matrix
    /// order (row-major as reported by `0x82/0x09`).
    pub fn set_lightbox_colors(&self, colors: &[Rgb]) -> Result<(), String> {
        if colors.is_empty() {
            return Err("empty lightbox matrix".into());
        }
        let mut data = Vec::with_capacity(colors.len() * 2);
        for c in colors {
            data.extend_from_slice(&rgb565_be(c));
        }
        for p in build_packets(CMD_LIGHTBOX_W, 0x03, &data, 56) {
            self.send_command(&p)?;
        }
        Ok(())
    }

    /// `0x06/0` — persist per-key colors into the onboard custom-light region
    /// (`effectId = 19` 自定义). 5 bytes per entry: `BE16(id) + RGB`, ≤ 11 per packet.
    pub fn write_custom_colors(&self, entries: &[KeyColor]) -> Result<(), String> {
        let mut data = Vec::with_capacity(entries.len() * 5);
        for e in entries {
            data.extend_from_slice(&e.id.to_be_bytes());
            data.extend_from_slice(&[e.color.r, e.color.g, e.color.b]);
        }
        for p in build_packets(CMD_CUSTOM_W, 0x00, &data, 55) {
            self.send_command(&p)?;
        }
        Ok(())
    }

    /// `0x86/0` — one key's stored custom color.
    ///
    /// ⚠ Deliberately a **single** id: on this firmware a multi-id request comes
    /// back misaligned (see `docs/commands.md` §4.1), so callers read one key at
    /// a time. The reply is checked against the requested id.
    pub fn read_custom_color(&self, id: u16) -> Result<Rgb, String> {
        let pkt = build_app_packet(CMD_CUSTOM_R, 0x00, &id.to_be_bytes());
        let r = self.exchange(&pkt)?.ok_or("no reply (timeout)")?;
        let got = u16::from_be_bytes([r[6], r[7]]);
        if got != id {
            return Err(format!("设备回显的 id 不匹配（请求 {id}，收到 {got}）"));
        }
        Ok(Rgb { r: r[8], g: r[9], b: r[10] })
    }
}

/// Capability block only (`0x82/0x09` + `0x82/0x0f`), for the stepped read path.
#[tauri::command]
pub fn lighting_caps(state: tauri::State<'_, AppState>) -> Result<Option<LightingCaps>, String> {
    with_device(&state, |d| Ok(d.lighting_caps().ok()))
}

/// One zone's effect block (`0x84/<base>`). Split out of `lighting_overview` so
/// the UI can read the zones one at a time and show real progress — on the
/// wireless link each of these costs a full round trip.
#[tauri::command]
pub fn lighting_zone(
    state: tauri::State<'_, AppState>,
    base: u8,
    direction_supported: bool,
) -> Result<ZoneEffect, String> {
    with_device(&state, |d| d.read_zone_effect(base, direction_supported))
}

#[tauri::command]
pub fn lighting_overview(state: tauri::State<'_, AppState>) -> Result<LightingOverview, String> {    with_device(&state, |d| {
        let caps = d.lighting_caps().ok();
        let direction_supported = caps
            .as_ref()
            .map(|c| c.direction_supported)
            .unwrap_or(false);
        let mut zones = Vec::with_capacity(ZONES.len());
        for (base, name) in ZONES {
            let supported = match &caps {
                // Capability read failed: try every zone, let the reads decide.
                None => true,
                Some(c) => match base {
                    BASE_SIDE => c.side_light,
                    BASE_LOGO => c.logo_light,
                    BASE_LIGHTBOX => c.lightbox_rows > 0 && c.lightbox_cols > 0,
                    _ => true, // main zone always exists
                },
            };
            let (effect, error) = if !supported {
                (None, None)
            } else {
                match d.read_zone_effect(base, direction_supported) {
                    Ok(e) => (Some(e), None),
                    Err(e) => (None, Some(e)),
                }
            };
            zones.push(ZoneState { base, name, supported, effect, error });
        }
        Ok(LightingOverview { caps, zones })
    })
}

#[tauri::command]
pub fn set_zone_effect(
    state: tauri::State<'_, AppState>,
    base: u8,
    effect: ZoneEffect,
) -> Result<(), String> {
    with_device(&state, |d| {
        let direction_supported = d.lighting_caps().ok().map(|c| c.direction_supported).unwrap_or(false);
        d.write_zone_effect(base, &effect, direction_supported)
    })
}

/// 「把 Windows 主题强调色写进主灯与侧灯」的结果：写进去的颜色 + 每个灯区是否成功。
#[derive(Debug, Clone, Serialize)]
pub struct AccentZoneResult {
    pub base: u8,
    pub name: &'static str,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccentApplyResult {
    pub color: Rgb,
    pub zones: Vec<AccentZoneResult>,
}

/// 读 `0x84/<base>` 的当前效果 → 只把颜色换成 Windows 强调色（`colorIndex = 0`
/// 固定色），effectId / brightness / speed / direction 原样保留 → 用 `0x04/<base>`
/// 整块写回。只碰主灯与侧灯，一个灯区失败不影响另一个（结果里逐个报告）。
#[tauri::command]
pub fn apply_accent_to_zones(state: tauri::State<'_, AppState>) -> Result<AccentApplyResult, String> {
    let color = crate::music::accent_color()?;
    with_device(&state, |d| {
        let direction_supported = d
            .lighting_caps()
            .ok()
            .map(|c| c.direction_supported)
            .unwrap_or(false);
        let mut zones = Vec::new();
        for (base, name) in [(BASE_MAIN, "主灯"), (BASE_SIDE, "侧灯")] {
            let written = (|| -> Result<(), String> {
                let mut effect = d.read_zone_effect(base, direction_supported)?;
                effect.color = color;
                effect.color_index = 0;
                d.write_zone_effect(base, &effect, direction_supported)
            })();
            zones.push(AccentZoneResult {
                base,
                name,
                ok: written.is_ok(),
                error: written.err(),
            });
        }
        Ok(AccentApplyResult { color, zones })
    })
}

#[tauri::command]
pub fn set_full_keys_rgb(state: tauri::State<'_, AppState>, color: Rgb) -> Result<(), String> {
    with_device(&state, |d| d.set_full_keys_rgb(&color))
}

#[tauri::command]
pub fn set_key_colors(state: tauri::State<'_, AppState>, entries: Vec<KeyColor>) -> Result<(), String> {
    with_device(&state, |d| d.set_key_colors(&entries))
}

/// 一帧逐键颜色**实际**走的下发通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorChannel {
    /// 无线裸报文：一帧若干条 20 字节报文，不等应答。
    Wireless,
    /// 应用包 `0x08/1`：63 字节信封（无线下再切 5 帧并逐帧等 ACK）。
    App,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeyColorsResult {
    /// 本帧真正用上的通道。裸报文写失败时会是 `App`。
    pub channel: ColorChannel,
    /// 裸报文通道发出的报文条数（应用包通道为 0）。
    pub packets: usize,
    /// 裸报文通道在链路层就失败了、于是退回应用包通道时的原因。
    pub fallback: Option<String>,
}

/// 逐键颜色下发：**先走无线裸报文通道**，只在写报文这一步失败时退回应用包
/// `0x08/1`（`set_key_colors`），并把实际通道回报给前端。
///
/// 退回的理由只有一种：`hidapi` 的写调用返回了错误。裸报文是发射即忘的通道，
/// 设备收下却不理会它时这里**看不见**——那是固件行为，只能由用户看灯切通道
/// （前端因此给出了「当前通道」读数和一个手动开关）。
#[tauri::command]
pub fn set_key_colors_wireless(
    state: tauri::State<'_, AppState>,
    entries: Vec<KeyColor>,
) -> Result<KeyColorsResult, String> {
    with_device(&state, |d| match d.set_key_colors_wireless(&entries) {
        Ok(packets) => Ok(KeyColorsResult {
            channel: ColorChannel::Wireless,
            packets,
            fallback: None,
        }),
        Err(reason) => {
            d.set_key_colors(&entries)?;
            Ok(KeyColorsResult {
                channel: ColorChannel::App,
                packets: 0,
                fallback: Some(reason),
            })
        }
    })
}

#[tauri::command]
pub fn set_lightbox_colors(state: tauri::State<'_, AppState>, colors: Vec<Rgb>) -> Result<(), String> {
    with_device(&state, |d| d.set_lightbox_colors(&colors))
}

/// `0x06/0` — persist per-key colors into the custom-light region (effectId 19).
#[tauri::command]
pub fn write_custom_colors(
    state: tauri::State<'_, AppState>,
    entries: Vec<KeyColor>,
) -> Result<(), String> {
    with_device(&state, |d| d.write_custom_colors(&entries))
}

/// `0x86/0` — read one key's stored custom color (single id; see the service doc).
#[tauri::command]
pub fn read_custom_color(state: tauri::State<'_, AppState>, id: u16) -> Result<Rgb, String> {
    with_device(&state, |d| d.read_custom_color(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::build_raw_reports;

    /// 逐键颜色的数据区编码（两条通道共用）与错误处理。
    #[test]
    fn key_color_payload_matches_the_sdk_layout() {
        let key = |id, r, g, b| KeyColor { id, color: Rgb { r, g, b } };
        let data = AulaDevice::key_color_payload(&[
            key(1, 1, 2, 3),
            key(2, 1, 2, 3),
            key(3, 9, 8, 7),
        ])
        .unwrap();
        // 同色合并成一组：[r,g,b,count,...ids]，组按首次出现的顺序排列。
        assert_eq!(data, vec![1, 2, 3, 2, 1, 2, 9, 8, 7, 1, 3]);
        // 同一个 id 出现两次是配置错误，宁可不发也不发一帧坏数据。
        assert!(AulaDevice::key_color_payload(&[key(1, 0, 0, 0), key(1, 0, 0, 0)]).is_err());
    }

    /// 音乐律动的一帧（15 列各 4 键 + 8 键黑 = 16 色 / 68 键 = 132 字节）在快通道上
    /// 是 11 条报文。这正是它比 `0x08/1` 值得的理由：一次应用包往返的钱，在这里
    /// 够发 11 条不用等应答的报文。
    #[test]
    fn a_music_frame_costs_11_reports() {
        let mut frame = Vec::new();
        for col in 0..15u16 {
            for i in 0..4u16 {
                frame.push(KeyColor {
                    id: col * 4 + i + 1,
                    color: Rgb { r: col as u8 + 1, g: 0, b: 0 },
                });
            }
        }
        for id in 61..69u16 {
            frame.push(KeyColor { id, color: Rgb { r: 0, g: 0, b: 0 } });
        }
        let data = AulaDevice::key_color_payload(&frame).unwrap();
        assert_eq!(data.len(), 4 * 16 + 68);
        assert_eq!(build_raw_reports(RAW_TYPE_KEY, &data).len(), 11);
    }
}
