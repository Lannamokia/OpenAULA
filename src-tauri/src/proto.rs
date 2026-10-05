//! Protocol layer, ported 1:1 from `tools/aula_hid.py` (spiderdriver project),
//! which was verified against the real device. See the parent project's
//! `docs/protocol.md` for the full protocol description.
//!
//! Three layers: HID report (19-byte frame, report id 9) -> link frames
//! (0x66 magic, per-frame ACK) -> application packet (63-byte envelope).
//!
//! Two link variants:
//!   - PID 0x106C (8K wireless receiver): 64-byte data split into 5x 14-byte
//!     frames, each frame individually ACKed.
//!   - anything else (e.g. wired 0x103E): the 63-byte application packet is
//!     sent as one whole report, no frames, no per-frame ACK.

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

pub const EVENT_CMD: [u8; 3] = [0xFE, 0x98, 0x94];

/// Frame-level checksum: `sum(data) & 0xFF`.
pub fn checksum(data: &[u8]) -> u8 {
    (data.iter().map(|&b| b as u32).sum::<u32>() & 0xFF) as u8
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

/// Whether an application packet is an async event (not a request reply).
pub fn is_event(app: &[u8]) -> bool {
    if app.is_empty() || !EVENT_CMD.contains(&app[0]) {
        return false;
    }
    match app[0] {
        0x98 => app[1] == 0,
        0x94 => app[1] == 2,
        _ => true, // 0xFE: any param
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
