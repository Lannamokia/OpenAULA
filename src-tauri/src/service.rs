//! High-level device session: link-adaptive exchange plus the service
//! operations (device info / battery / keymap / profiles / macros /
//! advanced keys). Semantics ported from `tools/aula_hid.py`; command
//! byte layouts from the parent project's `docs/commands.md`.
//!
//! Link selection mirrors the SDK: `product_id == 0x106C` (8K wireless
//! receiver) uses 0x66 framing with per-frame ACKs; any other PID (e.g.
//! wired 0x103E) sends the 63-byte application packet as one report.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use hidapi::HidDevice;
use serde::{Deserialize, Serialize};

use crate::proto::*;

const READ_CHUNK_MS: i32 = 120;
const FRAME_GAP: Duration = Duration::from_millis(12);

pub struct AulaDevice {
    dev: HidDevice,
    pub desc: crate::hid::DeviceDesc,
    framed: bool,
    sync: std::cell::Cell<SyncCounter>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEntry {
    pub id: u16,
    pub keycode: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Battery {
    pub level: u8,
    pub flags: u8,
    pub charging: bool,
}

impl AulaDevice {
    pub fn new(dev: HidDevice, desc: crate::hid::DeviceDesc) -> Self {
        let framed = desc.product_id == WIRELESS_PID;
        Self {
            dev,
            desc,
            framed,
            sync: std::cell::Cell::new(SyncCounter::default()),
        }
    }

    pub fn is_framed(&self) -> bool {
        self.framed
    }

    fn next_frames(&self, packet: &[u8; PACKET_SIZE]) -> Vec<[u8; 19]> {
        let mut s = self.sync.get();
        let frames = build_frames(packet, &mut s);
        self.sync.set(s);
        frames
    }

    // --- link layer -------------------------------------------------------

    fn write_report(&self, data: &[u8]) -> Result<(), String> {
        self.dev.write(data).map(|_| ()).map_err(|e| e.to_string())
    }

    fn read_frame(&self, timeout_ms: i32) -> Result<Option<Vec<u8>>, String> {
        let mut buf = [0u8; 64];
        let n = self
            .dev
            .read_timeout(&mut buf, timeout_ms)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        let mut b = buf[..n].to_vec();
        if b[0] == REPORT_ID {
            b.remove(0);
        }
        Ok(Some(b))
    }

    /// Wired / generic link: send the 63-byte packet as one report, wait for
    /// a reply whose cmd/param match (events filtered out).
    fn exchange_raw(&self, packet: &[u8; PACKET_SIZE], timeout: Duration) -> Result<Option<[u8; PACKET_SIZE]>, String> {
        let mut msg = Vec::with_capacity(1 + PACKET_SIZE);
        msg.push(REPORT_ID);
        msg.extend_from_slice(packet);
        self.write_report(&msg)?;
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let Some(buf) = self.read_frame(200)? else {
                continue;
            };
            if buf.len() < PACKET_SIZE {
                continue;
            }
            let b = &buf[..PACKET_SIZE];
            if is_event(b) {
                continue;
            }
            if b[0] == packet[0] && b[1] == packet[1] {
                let mut out = [0u8; PACKET_SIZE];
                out.copy_from_slice(b);
                return Ok(Some(out));
            }
        }
        Ok(None)
    }

    /// 8K wireless link: 5 frames out (per-frame ACK), then read response
    /// fragments, ACKing every received frame (the device only continues
    /// sending while its frames are ACKed).
    fn exchange_framed_lockstep(
        &self,
        packet: &[u8; PACKET_SIZE],
        timeout: Duration,
    ) -> Result<Option<[u8; PACKET_SIZE]>, String> {
        for f in self.next_frames(packet) {
            let mut msg = Vec::with_capacity(1 + FRAME_SIZE);
            msg.push(REPORT_ID);
            msg.extend_from_slice(&f);
            self.write_report(&msg)?;
            std::thread::sleep(FRAME_GAP);
        }
        let mut parts: BTreeMap<u8, Vec<u8>> = BTreeMap::new();
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline && parts.len() < 5 {
            let Some(buf) = self.read_frame(READ_CHUNK_MS)? else {
                continue;
            };
            if buf.first() != Some(&MAGIC) {
                continue;
            }
            // ACK every frame immediately, or the device stops sending.
            let ack = ack_frame(&buf);
            let mut msg = Vec::with_capacity(1 + FRAME_SIZE);
            msg.push(REPORT_ID);
            msg.extend_from_slice(&ack);
            self.write_report(&msg)?;
            let Some(r) = parse_frame(&buf) else {
                continue;
            };
            if !r.ok || r.len == 0 {
                continue; // ACK frame
            }
            if r.idx as usize != parts.len() + 1 {
                continue;
            }
            if r.idx == 1 && (r.data[0] != packet[0] || r.data[1] != packet[1]) {
                continue; // async event interleave
            }
            parts.insert(r.idx, r.data);
        }
        Ok(reassemble(&parts))
    }

    /// Send one application packet and wait for its reply, auto-selecting the
    /// link. Retries a failed framed exchange once (as the Python ref does).
    pub fn exchange(&self, packet: &[u8; PACKET_SIZE]) -> Result<Option<[u8; PACKET_SIZE]>, String> {
        if !self.framed {
            return self.exchange_raw(packet, Duration::from_millis(1000));
        }
        for attempt in 0..=1 {
            let r = self.exchange_framed_lockstep(packet, Duration::from_millis(2500))?;
            if r.is_some() {
                return Ok(r);
            }
            if attempt == 0 {
                continue;
            }
            return Ok(None);
        }
        Ok(None)
    }

    /// Send a command and return the fixed-size data area of the reply.
    ///
    /// NOTE: `dataLength` (packet[5]) is unreliable on reads — the device
    /// often sends data with length 0. Always read by the documented fixed
    /// reply size (see `docs/commands.md`).
    pub fn read_cmd(&self, cmd: u8, param: u8, size: usize) -> Result<Vec<u8>, String> {
        let pkt = build_app_packet(cmd, param, &[]);
        let r = self.exchange(&pkt)?.ok_or("no reply (timeout)")?;
        let n = size.min(56);
        Ok(r[6..6 + n].to_vec())
    }

    // --- services ---------------------------------------------------------

    /// `0x87` battery: `[0]` = percent, `[1]` high nibble = charging.
    pub fn battery(&self) -> Result<Battery, String> {
        let d = self.read_cmd(0x87, 0x00, 2)?;
        Ok(Battery {
            level: d[0],
            flags: d[1],
            charging: d[1] & 0xF0 != 0,
        })
    }

    /// `0x82/0x01` UUID as 6 raw bytes (big-endian integer in the SDK).
    pub fn uuid(&self) -> Result<Vec<u8>, String> {
        self.read_cmd(0x82, 0x01, 6)
    }

    /// `0x82/0x02` firmware version, LE16: major=v>>8, minor=(v>>4)&15, sub=v&15.
    pub fn firmware_version(&self) -> Result<String, String> {
        let d = self.read_cmd(0x82, 0x02, 2)?;
        let v = (d[0] as u16) << 8 | d[1] as u16;
        Ok(format!("{}.{}.{}", v >> 8, (v >> 4) & 15, v & 15))
    }

    /// `0x90/0x00` current onboard profile index.
    pub fn profile(&self) -> Result<u8, String> {
        Ok(self.read_cmd(0x90, 0x00, 1)?[0])
    }

    /// Read keymap records for `ids` on `layer`/`system`, 9 ids per packet.
    pub fn read_keymap(&self, layer: u8, system: u8, ids: &[u16]) -> Result<Vec<KeyEntry>, String> {
        let mut out = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(9) {
            let mut data = Vec::with_capacity(chunk.len() * 2);
            for id in chunk {
                data.extend_from_slice(&id.to_be_bytes());
            }
            let pkt = build_app_packet(CMD_KEYMAP_R, els(layer, system), &data);
            let r = self.exchange(&pkt)?.ok_or("no reply (timeout)")?;
            for rec in r[6..6 + chunk.len() * 6].chunks_exact(6) {
                out.push(KeyEntry {
                    id: u16::from_be_bytes([rec[0], rec[1]]),
                    keycode: u32::from_be_bytes([rec[2], rec[3], rec[4], rec[5]]),
                });
            }
        }
        Ok(out)
    }

    /// Write keymap records (6 bytes each: BE16 id + BE32 keycode), 9 per packet.
    pub fn write_keymap(&self, layer: u8, system: u8, entries: &[KeyEntry]) -> Result<(), String> {
        let mut data = Vec::with_capacity(entries.len() * 6);
        for e in entries {
            data.extend_from_slice(&e.id.to_be_bytes());
            data.extend_from_slice(&e.keycode.to_be_bytes());
        }
        for chunk in build_packets(CMD_KEYMAP_W, els(layer, system), &data, 54) {
            self.exchange(&chunk)?;
        }
        Ok(())
    }

    /// `0x10/0x00` switch onboard profile. The profile number lives in the
    /// DATA byte, not in param (see commands.md §3).
    pub fn switch_profile(&self, n: u8) -> Result<(), String> {
        let pkt = build_app_packet(CMD_PROFILE_W, 0x00, &[n]);
        self.exchange(&pkt)?;
        Ok(())
    }

    /// Read the whole macro region (header table + macro bodies).
    ///
    /// `0x85/0x00` with offset injection (SDK `buildMacroCommands`): the
    /// request data is `total_len` zero bytes to span multiple packets.
    pub fn read_macro_region(&self, total_len: usize) -> Result<Vec<u8>, String> {
        let mut pkts = build_packets(CMD_MACRO_R, 0, &vec![0u8; total_len], 56);
        inject_macro_offsets(&mut pkts, 56);
        let mut out = Vec::with_capacity(total_len);
        for p in &pkts {
            let r = self.exchange(p)?.ok_or("no reply (timeout)")?;
            out.extend_from_slice(&r[6..6 + 56]);
        }
        out.truncate(total_len);
        Ok(out)
    }

    /// Write a whole macro region back (`0x05/0x00`, no offset injection).
    ///
    /// ⚠ Always read the full region first: the device erases anything
    /// beyond the written length (see commands.md §5).
    pub fn write_macro_region(&self, region: &[u8]) -> Result<(), String> {
        for p in build_packets(CMD_MACRO_W, 0, region, 56) {
            self.exchange(&p)?;
        }
        Ok(())
    }

    /// Write an advanced key record (`0x12`, type injected into `[2]`).
    /// `data` is the type-specific body (see commands.md §6).
    pub fn write_advanced_key(
        &self,
        layer: u8,
        system: u8,
        key_type: u8,
        data: &[u8],
    ) -> Result<(), String> {
        let mut pkts = build_packets(CMD_ADV_W, els(layer, system), data, 56);
        inject_advanced_type(&mut pkts, key_type);
        for p in &pkts {
            self.exchange(p)?;
        }
        Ok(())
    }

    /// Delete an advanced key by id (`0x12`, data = BE16(id)).
    pub fn delete_advanced_key(&self, layer: u8, system: u8, id: u16) -> Result<(), String> {
        let pkt = build_app_packet(CMD_ADV_W, els(layer, system), &id.to_be_bytes());
        self.exchange(&pkt)?;
        Ok(())
    }

    /// Raw command for the debug panel: returns request + response hex.
    pub fn raw_exchange(&self, cmd: u8, param: u8, data: &[u8]) -> Result<(String, Option<String>), String> {
        let pkt = build_app_packet(cmd, param, data);
        let r = self.exchange(&pkt)?;
        Ok((
            pkt.iter().map(|b| format!("{b:02x}")).collect(),
            r.map(|p| p.iter().map(|b| format!("{b:02x}")).collect()),
        ))
    }
}
