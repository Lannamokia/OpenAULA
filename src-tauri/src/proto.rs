//! Protocol layer, ported 1:1 from `tools/aula_hid.py` (spiderdriver project),
//! which was verified against the real device. See the parent project's
//! `docs/protocol.md` for the full protocol description.
//!
//! Three layers: HID report (20 bytes, report id 9 + 19 payload) -> link frames
//! (0x66 magic, per-frame ACK) -> application packet (63-byte envelope).
//!
//! Two link variants:
//!   - PID 0x106C (8K wireless receiver): 64-byte data split into 5x 14-byte
//!     frames, each frame individually ACKed.
//!   - anything else (e.g. wired 0x103E): the 63-byte application packet is
//!     sent as one whole report, no frames, no per-frame ACK.
//!
//! On top of those there is a third, independent channel: the SDK's
//! `*ByWireless` family puts the lighting payload **directly in a 20-byte
//! report** — no envelope, no 0x66 frames, no ACK. See [`build_raw_reports`].

pub const VID: u16 = 0x372E;
pub const WIRELESS_PID: u16 = 0x106C; // 8K wireless receiver -> framed
pub const WIRED_PID: u16 = 0x103E; // wired HERO 68 XS (measured) -> raw
pub const REPORT_ID: u8 = 9;
pub const MAGIC: u8 = 0x66;
pub const PACKET_SIZE: usize = 63;
pub const FRAME_SIZE: usize = 19; // report id byte + 19 payload bytes on the wire
pub const USAGE_PAGE: u16 = 0xFF60;
pub const USAGE: u16 = 0x61;

pub const CMD_KEYMAP_R: u8 = 0x83;
pub const CMD_KEYMAP_W: u8 = 0x03;
pub const CMD_MACRO_R: u8 = 0x85;
pub const CMD_MACRO_W: u8 = 0x05;
pub const CMD_ADV_R: u8 = 0x92;
pub const CMD_ADV_W: u8 = 0x12;
pub const CMD_PROFILE_R: u8 = 0x90;
pub const CMD_PROFILE_W: u8 = 0x10;
/// 灯光写入命令字：应用包 `0x08/<param>`，裸报文里是 report id 之后的第一个字节。
pub const CMD_RGB: u8 = 0x08;

pub const EVENT_CMD: [u8; 3] = [0xFE, 0x98, 0x94];

/// 无线裸报文（SDK `*ByWireless` 系列）的整条 HID 报文长度：report id + 19 字节载荷。
/// 与链路帧同宽 —— 两者共用同一条 20 字节的报告。
pub const RAW_REPORT_SIZE: usize = 1 + FRAME_SIZE;
/// 一条裸报文最多携带的数据字节数（SDK: `(20 - 6) - 1`）。
pub const RAW_DATA_PER_REPORT: usize = 13;

/// Frame-level checksum: `sum(data) & 0xFF`.
pub fn checksum(data: &[u8]) -> u8 {
    (data.iter().map(|&b| b as u32).sum::<u32>() & 0xFF) as u8
}

/// 裸报文校验和：`255 - (Σ(body) & 0xFF)`。
///
/// ⚠ 求和范围是**整条报文除了校验和自己**的那 19 个字节，也就是说 **report id
/// （9）也计入** —— SDK 是对 `[9, 0x08, total, index, (type<<4)|len, ...data, 0…]`
/// 这个已经含 report id 的数组求和取反的。
pub fn raw_checksum(body: &[u8]) -> u8 {
    255u8.wrapping_sub(checksum(body))
}

/// 组装一条 20 字节裸报文：
/// `[0x09, 0x08, total, index, (kind<<4)|len, ...data(≤13), 0…, crc]`。
///
/// `total` = 这一帧的报文总数，`index` = **从 0 开始**的序号。数据不足时用 0 补齐
/// 到校验和之前，`crc` 落在最后一个字节。
pub fn build_raw_report(kind: u8, total: u8, index: u8, chunk: &[u8]) -> [u8; RAW_REPORT_SIZE] {
    let mut b = [0u8; RAW_REPORT_SIZE];
    b[0] = REPORT_ID;
    b[1] = CMD_RGB;
    b[2] = total;
    b[3] = index;
    b[4] = (kind << 4) | (chunk.len() as u8 & 0x0F);
    let n = chunk.len().min(RAW_DATA_PER_REPORT);
    b[5..5 + n].copy_from_slice(&chunk[..n]);
    let last = RAW_REPORT_SIZE - 1;
    b[last] = raw_checksum(&b[..last]);
    b
}

/// 按 13 字节切分，组装一帧的全部裸报文。空数据不产生任何报文（SDK 同样如此）。
///
/// 超过 255 包（3315 字节）时 `total` 会溢出；灯光一帧远达不到这个量级
/// （见 `lighting::RGB_PAYLOAD_MAX`）。
pub fn build_raw_reports(kind: u8, data: &[u8]) -> Vec<[u8; RAW_REPORT_SIZE]> {
    let total = data.len().div_ceil(RAW_DATA_PER_REPORT);
    (0..total)
        .map(|i| {
            let start = i * RAW_DATA_PER_REPORT;
            let end = (start + RAW_DATA_PER_REPORT).min(data.len());
            build_raw_report(kind, total as u8, i as u8, &data[start..end])
        })
        .collect()
}

/// Application-layer checksum: value that makes the whole packet
/// (`[0x09] + packet[0..61]`) sum to `0xFF` (i.e. `& 0xFF == 0xF6`).
pub fn app_checksum(p: &[u8; PACKET_SIZE]) -> u8 {
    (0xF6u16.wrapping_sub((checksum(&p[..62])) as u16) & 0xFF) as u8
}

/// Build a single-packet application envelope.
pub fn build_app_packet(cmd: u8, param: u8, data: &[u8]) -> [u8; PACKET_SIZE] {
    let mut p = [0u8; PACKET_SIZE];
    p[0] = cmd;
    p[1] = param;
    p[2] = 0;
    p[3] = 1;
    p[4] = 0;
    p[5] = data.len() as u8;
    let n = data.len().min(56);
    p[6..6 + n].copy_from_slice(&data[..n]);
    p[62] = app_checksum(&p);
    p
}

/// Split `data` into multi-packet commands (SDK `buildCommands`).
/// `p[3]` = total packets, `p[4]` = current index, `p[5]` = data length.
pub fn build_packets(
    cmd: u8,
    param: u8,
    data: &[u8],
    per_packet: usize,
) -> Vec<[u8; PACKET_SIZE]> {
    let per_packet = per_packet.clamp(1, 56);
    let n = (data.len() + per_packet - 1) / per_packet;
    let n = n.max(1);
    let mut pkts = Vec::with_capacity(n);
    for i in 0..n {
        let chunk = &data[i * per_packet..((i + 1) * per_packet).min(data.len())];
        let mut p = [0u8; PACKET_SIZE];
        p[0] = cmd;
        p[1] = param;
        p[2] = 0;
        p[3] = n as u8;
        p[4] = i as u8;
        p[5] = chunk.len() as u8;
        p[6..6 + chunk.len()].copy_from_slice(chunk);
        p[62] = app_checksum(&p);
        pkts.push(p);
    }
    pkts
}

/// Macro pre-processing (SDK `buildMacroCommands`): writes each packet's data
/// offset within the macro region into `[1]` (high) / `[2]` (low), overwriting
/// the param bytes, then recomputes the checksum.
pub fn inject_macro_offsets(pkts: &mut [[u8; PACKET_SIZE]], per_packet: usize) {
    for (i, p) in pkts.iter_mut().enumerate() {
        let off = i * per_packet;
        p[1] = ((off >> 8) & 0xFF) as u8;
        p[2] = (off & 0xFF) as u8;
        p[62] = app_checksum(p);
    }
}

/// Advanced-key pre-processing (SDK `buildAdvancedKeyCommands`): writes the
/// key type into `[2]` of every packet, then recomputes the checksum.
pub fn inject_advanced_type(pkts: &mut [[u8; PACKET_SIZE]], key_type: u8) {
    for p in pkts.iter_mut() {
        p[2] = key_type;
        p[62] = app_checksum(p);
    }
}

/// `param = ELS(layer, system) = (layer & 3) | ((system & 7) << 2)`.
pub fn els(layer: u8, system: u8) -> u8 {
    (layer & 3) | ((system & 7) << 2)
}

/// 3-bit rolling sync counter (host-side; the device mirrors it but does not
/// validate it — any starting value works, we increment by 1 per frame).
#[derive(Default, Clone, Copy)]
pub struct SyncCounter(pub u8);

impl SyncCounter {
    pub fn next(&mut self) -> u8 {
        let c = self.0;
        self.0 = (self.0 + 1) % 8;
        c
    }
}

/// Fragment one application packet into 5x 19-byte frames.
///
/// Host-direction data is 64 bytes (`0x09` report id + 63-byte packet), split
/// 14/14/14/14/8; the report id rides as payload byte 0 of fragment 1.
/// Each returned frame is the 19-byte body; the caller prepends the report id
/// on the wire.
pub fn build_frames(packet: &[u8; PACKET_SIZE], sync: &mut SyncCounter) -> Vec<[u8; 19]> {
    let mut frames = Vec::with_capacity(5);
    for i in 0..5u8 {
        // Python reference: chunks = pkt[0:13], pkt[13:27], pkt[27:41],
        // pkt[41:55], pkt[55:63]  ->  13/14/14/14/8.
        let (start, end) = match i {
            0 => (0usize, 13usize),
            _ => (13 + (i as usize - 1) * 14, (13 + i as usize * 14).min(PACKET_SIZE)),
        };
        let c = sync.next();
        let ln = (end - start) as u8 + if i == 0 { 1 } else { 0 };
        let mut body: Vec<u8> = vec![
            MAGIC,
            0x05 | (((c >> 2) & 1) << 7),
            (i + 1) | (((c >> 1) & 1) << 7),
            ln | ((c & 1) << 7),
        ];
        if i == 0 {
            body.push(REPORT_ID);
        }
        body.extend_from_slice(&packet[start..end]);
        let sum = checksum(&body);
        let mut out = [0u8; 19];
        out[..body.len()].copy_from_slice(&body);
        out[body.len()] = sum;
        frames.push(out);
    }
    frames
}

/// Parse a received 19-byte frame (report id already stripped).
#[derive(Debug, Clone)]
pub struct Frame {
    pub idx: u8,
    pub len: u8,
    pub data: Vec<u8>,
    pub ok: bool,
}

pub fn parse_frame(buf: &[u8]) -> Option<Frame> {
    if buf.len() < 5 || buf[0] != MAGIC {
        return None;
    }
    let ln = buf[3] & 0x7F;
    if buf.len() < 4 + ln as usize + 1 {
        return None;
    }
    let end = 4 + ln as usize;
    Some(Frame {
        idx: buf[2] & 0x7F,
        len: ln,
        data: buf[4..end].to_vec(),
        ok: buf[end] == checksum(&buf[..end]),
    })
}

/// Build the ACK for a received frame: copy the first 3 bytes, clear the
/// length low 7 bits (keep bit7 = syncFlag), recompute the checksum.
pub fn ack_frame(frame: &[u8]) -> [u8; 19] {
    let body = [frame[0], frame[1], frame[2], frame[3] & 0x80];
    let mut out = [0u8; 19];
    out[..4].copy_from_slice(&body);
    out[4] = checksum(&body);
    out
}

/// Reassemble 5 response fragments into a 63-byte application packet.
pub fn reassemble(parts: &std::collections::BTreeMap<u8, Vec<u8>>) -> Option<[u8; PACKET_SIZE]> {
    let mut out = Vec::with_capacity(PACKET_SIZE);
    for i in 1..=5u8 {
        out.extend_from_slice(parts.get(&i)?);
    }
    out.truncate(PACKET_SIZE);
    let mut pkt = [0u8; PACKET_SIZE];
    pkt.copy_from_slice(&out);
    Some(pkt)
}

/// Whether an application packet is an async report (not a reply to a request).
///
/// `0xFE` / `0x94` use the short 2-byte event header, but the **`0x98` travel
/// monitor stream is a normal 63-byte envelope packet with `param = 1`** whose
/// checksum validates like any other (`Read = 1`; `Start = 0`, `Stop = 2`).
/// See the measurement note in `docs/commands.md` §11.3.
pub fn is_event(app: &[u8]) -> bool {
    if app.is_empty() || !EVENT_CMD.contains(&app[0]) {
        return false;
    }
    match app[0] {
        0x98 => app[1] == 1,
        0x94 => app[1] == 2,
        _ => true, // 0xFE: any param
    }
}

/// Data area of an event packet.
///
/// `0x98` (travel monitor) and `0x94/param=2` (calibration progress) both arrive
/// as **normal 63-byte envelope packets** — `[5]` = length, data at `[6]`, with a
/// valid application checksum. Only `0xFE` uses the short 2-byte head.
///
/// (Measured 2026-10-06: `94 02 00 01 00 06 | 00 01 85 68 05 65 | …` — envelope.)
pub fn event_data(app: &[u8]) -> &[u8] {
    if app.len() < 2 {
        return &[];
    }
    match app[0] {
        0x98 | 0x94 => {
            let n = (app[5] as usize).min(app.len().saturating_sub(6));
            &app[6..6 + n]
        }
        _ => &app[2..],
    }
}

/// Event names for `cmd == 0xFE` by param (SDK `onCommonBubbleResponse`).
pub fn event_name(cmd: u8, param: u8) -> Option<&'static str> {
    if cmd == 0xFE {
        Some(match param {
            2 => "DeviceDongleConnectChange",
            5 => "BatteryChange",
            7 => "SystemChange",
            9 => "ProfileChange",
            11 => "LightingEffectChange",
            14 => "FunctionStatusChange",
            _ => "Unknown",
        })
    } else if cmd == 0x98 && param == 0 {
        Some("KeyTravelMonitor")
    } else if cmd == 0x94 && param == 2 {
        Some("KeyCalibration")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn travel_and_calibration_use_the_envelope() {
        // Real captures (2026-10-06, wired HERO 68 XS).
        // 0x94/param=2 calibration: 94 02 00 01 00 06 | 00 01 85 68 05 65
        let mut cal = [0u8; PACKET_SIZE];
        cal[..12].copy_from_slice(&[
            0x94, 0x02, 0x00, 0x01, 0x00, 0x06, 0x00, 0x01, 0x85, 0x68, 0x05, 0x65,
        ]);
        assert!(is_event(&cal));
        assert_eq!(event_data(&cal), &[0x00, 0x01, 0x85, 0x68, 0x05, 0x65]);

        // 0x98 travel monitor: 98 01 00 01 00 06 | 00 36 00 00 25 d8
        let mut trav = [0u8; PACKET_SIZE];
        trav[..12].copy_from_slice(&[
            0x98, 0x01, 0x00, 0x01, 0x00, 0x06, 0x00, 0x36, 0x00, 0x00, 0x25, 0xd8,
        ]);
        assert!(is_event(&trav));
        assert_eq!(event_data(&trav), &[0x00, 0x36, 0x00, 0x00, 0x25, 0xd8]);
    }

    #[test]
    fn battery_event_keeps_the_short_head() {
        // Frame capture: fe 05 61 10 …  → data starts at offset 2.
        let mut ev = [0u8; PACKET_SIZE];
        ev[..5].copy_from_slice(&[0xFE, 0x05, 0x61, 0x10, 0x00]);
        assert!(is_event(&ev));
        // 0xFE keeps the short head, so the data slice runs to the end of the packet.
        assert_eq!(&event_data(&ev)[..3], &[0x61, 0x10, 0x00]);
    }

    /// 裸报文的期望字节由一段逐字照抄 SDK 的 JS 复现器产出（见交付报告），
    /// 不是从 `build_raw_report` 自己算出来的。
    fn hex(v: &[u8]) -> String {
        v.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")
    }

    /// `updateFullKeysRGBByWireless({r: 0x11, g: 0x22, b: 0x33})`
    /// —— 单条报文，type/len = 0x23（type 2 = `updateFullKeysRGB`，len 3）。
    #[test]
    fn full_keys_wireless_matches_the_sdk_packet() {
        use crate::lighting::RAW_TYPE_FULL;
        let mut want = vec![0x09, 0x08, 0x01, 0x00, 0x23, 0x11, 0x22, 0x33];
        want.extend_from_slice(&[0u8; 11]);
        want.push(0x64);
        assert_eq!(hex(&build_raw_report(RAW_TYPE_FULL, 1, 0, &[0x11, 0x22, 0x33])), hex(&want));
        // 同样一条也可以由切分函数走一遍：3 字节 → 1 包。
        assert_eq!(build_raw_reports(RAW_TYPE_FULL, &[0x11, 0x22, 0x33]).len(), 1);
    }

    /// `updateRGBByWireless` 的第一包：5 字节数据（r,g,b,count,id），
    /// type/len = 0x15（type 1 = `updateRGB`，len 5），余下补 0。
    #[test]
    fn key_colors_wireless_pads_and_signs_one_packet() {
        use crate::lighting::RAW_TYPE_KEY;
        let want = "09 08 01 00 15 01 02 03 01 04 00 00 00 00 00 00 00 00 00 cd";
        let reports = build_raw_reports(RAW_TYPE_KEY, &[1, 2, 3, 1, 4]);
        assert_eq!(reports.len(), 1);
        assert_eq!(hex(&reports[0]), want);
    }

    /// 14 字节数据切成两包：13 + 1，`total` = 2，`index` = 0 / 1。
    #[test]
    fn key_colors_wireless_splits_every_13_bytes() {
        use crate::lighting::RAW_TYPE_KEY;
        let data = [1, 2, 3, 1, 4, 5, 6, 7, 2, 8, 9, 10, 11, 12];
        let reports = build_raw_reports(RAW_TYPE_KEY, &data);
        assert_eq!(reports.len(), 2);
        assert_eq!(
            hex(&reports[0]),
            "09 08 02 00 1d 01 02 03 01 04 05 06 07 02 08 09 0a 0b 00 8a"
        );
        assert_eq!(
            hex(&reports[1]),
            "09 08 02 01 11 0c 00 00 00 00 00 00 00 00 00 00 00 00 00 ce"
        );
    }

    /// 灯珠变体（type 3，`updateRGBWithLedBeadsByWireless`）只有 type 半字节不同。
    #[test]
    fn led_beads_wireless_differs_only_in_the_type_nibble() {
        use crate::lighting::RAW_TYPE_BEADS;
        let data = [1, 2, 3, 1, 4, 5, 6, 7, 2, 8, 9, 10, 11, 12];
        let reports = build_raw_reports(RAW_TYPE_BEADS, &data);
        assert_eq!(
            hex(&reports[0]),
            "09 08 02 00 3d 01 02 03 01 04 05 06 07 02 08 09 0a 0b 00 6a"
        );
        assert_eq!(
            hex(&reports[1]),
            "09 08 02 01 31 0c 00 00 00 00 00 00 00 00 00 00 00 00 00 ae"
        );
    }

    /// 校验和 = `255 - Σ(整条报文去掉校验和自己的那 19 字节)`，含 report id。
    #[test]
    fn wireless_checksum_covers_the_report_id() {
        use crate::lighting::RAW_TYPE_KEY;
        let r = build_raw_report(RAW_TYPE_KEY, 1, 0, &[1, 2, 3, 1, 4]);
        let last = RAW_REPORT_SIZE - 1;
        let sum: u32 = r[..last].iter().map(|&b| b as u32).sum();
        assert_eq!(r[last], 255 - (sum % 256) as u8);
        // 少了 report id 的 9 就算不出这个数。
        let without: u32 = r[1..last].iter().map(|&b| b as u32).sum();
        assert_ne!(r[last], 255 - (without % 256) as u8);
    }

    /// 空数据不发报文（SDK 的包数也是 `ceil(0/13) = 0`）。
    #[test]
    fn empty_payload_sends_nothing() {
        use crate::lighting::RAW_TYPE_KEY;
        assert!(build_raw_reports(RAW_TYPE_KEY, &[]).is_empty());
    }

    #[test]
    fn replies_are_not_events() {
        // The empty reply to a 0x98/0x01 Start has param 2 territory only for
        // calibration; a travel Start reply (param 1) IS indistinguishable from the
        // stream by design, which is why Start must be fire-and-forget.
        let mut reply = [0u8; PACKET_SIZE];
        reply[..6].copy_from_slice(&[0x98, 0x02, 0x00, 0x01, 0x00, 0x00]);
        assert!(!is_event(&reply));
    }
}
