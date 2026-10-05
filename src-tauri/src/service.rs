//! High-level device session: link-adaptive exchange plus the service
//! operations (device info / battery / keymap / profiles / macros /
//! advanced keys). Semantics ported from `tools/aula_hid.py`; command
//! byte layouts from the parent project's `docs/commands.md`.
//!
//! Link selection mirrors the SDK: `product_id == 0x106C` (8K wireless
//! receiver) uses 0x66 framing with per-frame ACKs; any other PID (e.g.
//! wired 0x103E) sends the 63-byte application packet as one report.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use hidapi::HidDevice;
use serde::{Deserialize, Serialize};

use crate::proto::*;

const READ_CHUNK_MS: i32 = 120;
/// Attempts per command on the framed (wireless) link — see `exchange`.
const FRAMED_ATTEMPTS: usize = 3;
/// Per-attempt budget on the framed link. A healthy round trip is ~34ms, so
/// this is generous; the point of the retries is to survive a lost fragment.
const FRAMED_TIMEOUT: Duration = Duration::from_millis(1500);
/// Delay between the 5 fragments of one wireless transfer.
///
/// This is a **sustained-load** figure, not a burst one. An early 30-transfer
/// burst test suggested 0ms was fine (30/30, 36ms), but under continuous polling
/// it collapses: 8/50 transfers completed, each burning the full read deadline.
///
/// | gap | transfers ok | median |
/// |---|---|---|
/// | 0ms | 8/50 | 623ms |
/// | **1ms** | **50/50** | **87ms** |
/// | 4ms | 50/50 | 105ms |
/// | 12ms | 47/50 | 102ms |
///
/// Measured through the Rust path afterwards (8s of continuous polling, 1ms):
/// 97% success, median 43ms, P95 48ms.
const FRAME_GAP: Duration = Duration::from_millis(1);
/// Idle tick of the reader thread. `read_timeout` only waits this long when the
/// device has nothing to send — an arriving report completes the wait
/// immediately, so this value is *not* a latency bound; it only decides how
/// often an idle loop notices the stop flag.
const READER_IDLE_MS: i32 = 100;
/// Consecutive read errors tolerated before the reader thread gives up.
const READER_MAX_ERRORS: u32 = 5;
/// report id byte + largest payload (63-byte packet).
const READ_BUF: usize = 1 + PACKET_SIZE;
const READER_GONE: &str = "读取线程已退出（设备已断开）";
/// Depth of the reader queue. The producer runs at the device's report rate
/// (measured ~2880/s) while the consumer can be throttled to ~1 Hz by the
/// webview when the window is hidden, so the queue **must** be bounded;
/// 4096 is ~1.4 s of stream, past which old samples are worthless anyway.
const MAX_QUEUED_REPORTS: usize = 4096;

/// Result of taking a report (or failing to) out of `ReportQueue`.
enum Pop {
    Item(Vec<u8>),
    /// Nothing was queued (timeout / non-blocking call).
    Empty,
    /// The reader thread has exited and the queue is drained.
    Closed,
}

/// Bounded, drop-oldest queue between the reader thread and the command layer.
///
/// Deliberately *not* a bounded blocking channel: the reader thread must never
/// wait on a slow consumer (that would stall the HID ring buffer and lose more
/// than it saves), so a full queue evicts the **oldest** report and counts it.
/// For the travel/calibration streams the newest sample is the interesting one.
struct ReportQueue {
    q: Mutex<VecDeque<Vec<u8>>>,
    ready: Condvar,
    closed: AtomicBool,
    dropped: AtomicU64,
}

impl ReportQueue {
    fn new() -> Self {
        Self {
            q: Mutex::new(VecDeque::new()),
            ready: Condvar::new(),
            closed: AtomicBool::new(false),
            dropped: AtomicU64::new(0),
        }
    }

    /// Reader side: never blocks on a full queue.
    fn push(&self, b: Vec<u8>) {
        let mut q = self.q.lock().unwrap_or_else(|e| e.into_inner());
        if q.len() >= MAX_QUEUED_REPORTS {
            q.pop_front();
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        q.push_back(b);
        drop(q);
        self.ready.notify_one();
    }

    /// Reader side, on the way out: publish end-of-stream and wake every waiter
    /// (a parked consumer must not have to sit out its full timeout, or
    /// `AulaDevice::drop`'s `join` would wait behind it).
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.ready.notify_all();
    }

    /// Take a report, waiting at most `timeout` for one to appear. Queued
    /// reports are always handed out before `Closed` is reported.
    fn pop_timeout(&self, timeout: Duration) -> Pop {
        let mut q = self.q.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(b) = q.pop_front() {
                return Pop::Item(b);
            }
            if self.closed.load(Ordering::Acquire) {
                return Pop::Closed;
            }
            let now = Instant::now();
            if now >= deadline {
                return Pop::Empty;
            }
            let (guard, _) = self
                .ready
                .wait_timeout(q, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            q = guard; // timeout, or a woken push: either way re-check the state
        }
    }

    fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.q.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

pub struct AulaDevice {
    /// Write handle only; the reader thread owns a second handle to the same
    /// interface so reading never has to share state with writing.
    dev: HidDevice,
    pub desc: crate::hid::DeviceDesc,
    framed: bool,
    sync: std::cell::Cell<SyncCounter>,
    /// Reports pushed by the reader thread, report id already stripped.
    queue: Arc<ReportQueue>,
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
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
    /// `dev` is the write handle; `reader` is a second handle to the **same**
    /// interface, owned by a dedicated reader thread.
    ///
    /// Threading the read here (instead of polling with a timeout from the
    /// caller) is what removes the ~15.6 ms Windows timer quantisation from the
    /// data path: a blocked `WaitForSingleObject` returns the instant a report
    /// arrives, whereas a *timed* wait can only be woken on the system timer
    /// granularity, which capped the old polling loop at ~64 Hz.
    pub fn new(dev: HidDevice, reader: HidDevice, desc: crate::hid::DeviceDesc) -> Self {
        let framed = desc.product_id == WIRELESS_PID;
        let queue = Arc::new(ReportQueue::new());
        let stop = Arc::new(AtomicBool::new(false));
        let handle = std::thread::Builder::new()
            .name("aula-hid-reader".into())
            .spawn({
                let stop = Arc::clone(&stop);
                let queue = Arc::clone(&queue);
                move || Self::reader_loop(reader, queue, stop)
            })
            .expect("spawn HID reader thread");
        Self {
            dev,
            desc,
            framed,
            sync: std::cell::Cell::new(SyncCounter::default()),
            queue,
            stop,
            reader: Some(handle),
        }
    }

    /// Blocking read loop: push every report the device sends into the queue.
    ///
    /// A single transient I/O error must not silently kill reads for the rest of
    /// the session, so errors are retried with a short backoff and only give up
    /// after `READER_MAX_ERRORS` consecutive failures.
    fn reader_loop(reader: HidDevice, queue: Arc<ReportQueue>, stop: Arc<AtomicBool>) {
        let mut buf = [0u8; READ_BUF];
        let mut errors = 0u32;
        while !stop.load(Ordering::Relaxed) {
            match reader.read_timeout(&mut buf, READER_IDLE_MS) {
                // Idle tick (nothing within READER_IDLE_MS): loop so the stop
                // flag is re-checked. Must not be treated as end-of-stream.
                Ok(0) => {
                    errors = 0;
                    continue;
                }
                Ok(n) => {
                    errors = 0;
                    let mut b = buf[..n].to_vec();
                    if b.first() == Some(&REPORT_ID) {
                        b.remove(0);
                    }
                    queue.push(b); // bounded: evicts the oldest when full
                }
                Err(_) => {
                    errors += 1;
                    if errors >= READER_MAX_ERRORS {
                        break; // device gone (unplugged / handle invalidated)
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        queue.close(); // end-of-stream for anyone parked in `read_frame`
    }

    /// Number of reports evicted because the consumer fell behind (window
    /// hidden → webview throttling). Monotonic for the lifetime of the session.
    pub fn dropped_reports(&self) -> u64 {
        self.queue.dropped()
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

    /// Take the next report queued by the reader thread, waiting at most
    /// `timeout_ms`. `Ok(None)` = nothing arrived in time; `Err` = the reader
    /// thread is gone and the queue is drained (device closed or unplugged).
    fn read_frame(&self, timeout_ms: i32) -> Result<Option<Vec<u8>>, String> {
        match self
            .queue
            .pop_timeout(Duration::from_millis(timeout_ms.max(0) as u64))
        {
            Pop::Item(b) => Ok(Some(b)),
            Pop::Empty => Ok(None),
            Pop::Closed => Err(READER_GONE.into()),
        }
    }

    /// Non-blocking `read_frame`.
    fn try_read_frame(&self) -> Result<Option<Vec<u8>>, String> {
        self.read_frame(0)
    }

    /// Frame source for the drain loops: with `blocking == false` take whatever
    /// is already queued (`None` once the queue is empty); with `blocking ==
    /// true` wait for the next report but never past `deadline`.
    fn next_frame(&self, blocking: bool, deadline: Instant) -> Result<Option<Vec<u8>>, String> {
        if !blocking {
            return self.try_read_frame();
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Ok(None);
        }
        self.read_frame(left.as_millis().min(i32::MAX as u128) as i32)
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
        // Drop anything already queued: a stale frame left over from an earlier
        // transfer (or an unacknowledged fragment) makes the reply's fragment
        // numbering mismatch, which throws away the real answer and burns the
        // whole timeout. Flushing before sending costs nothing and makes every
        // transfer start from a clean slate.
        while self.try_read_frame()?.is_some() {}
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
    /// link.
    ///
    /// The framed (wireless) link loses the odd fragment — roughly one transfer
    /// in thirty — which would otherwise surface as a multi-second stall and a
    /// failed read. Retrying is cheap there (a round trip is ~34ms), so it gets
    /// more attempts than the wired link's single retry.
    pub fn exchange(&self, packet: &[u8; PACKET_SIZE]) -> Result<Option<[u8; PACKET_SIZE]>, String> {
        if !self.framed {
            return self.exchange_raw(packet, Duration::from_millis(1000));
        }
        for attempt in 0..FRAMED_ATTEMPTS {
            if let Some(r) = self.exchange_framed_lockstep(packet, FRAMED_TIMEOUT)? {
                return Ok(Some(r));
            }
            let _ = attempt;
        }
        Ok(None)
    }

    /// One transfer attempt with an explicit budget, no retries.
    pub fn exchange_once(
        &self,
        packet: &[u8; PACKET_SIZE],
        timeout: Duration,
    ) -> Result<Option<[u8; PACKET_SIZE]>, String> {
        if !self.framed {
            return self.exchange_raw(packet, timeout);
        }
        self.exchange_framed_lockstep(packet, timeout)
    }

    /// One harmless read (current onboard profile) with an explicit budget.
    ///
    /// The wireless keyboard sleeps when idle and then answers nothing; this is
    /// how the connect step tells "ready" from "asleep" instead of leaving the
    /// user staring at a hung UI.
    pub fn probe(&self, budget: Duration) -> bool {
        let pkt = build_app_packet(CMD_PROFILE_R, 0x00, &[]);
        if !self.framed {
            return matches!(self.exchange_raw(&pkt, budget), Ok(Some(_)));
        }
        matches!(self.exchange_framed_lockstep(&pkt, budget), Ok(Some(_)))
    }

    /// Write a packet **without waiting for a reply**.
    ///
    /// Needed by the travel monitor: its stream packets look exactly like the
    /// reply would (`0x98`/param 1), so waiting would burn a full timeout and
    /// swallow the samples the device pushes meanwhile.
    /// Send one application packet and get it **delivered**, without caring about
    /// the reply.
    ///
    /// The framed (wireless) link needs the full ACK handshake to complete a
    /// transfer: after the host's 5 frames the device answers with 5 ACK frames,
    /// and it only sends its own data once each of those is acknowledged. A
    /// fire-and-forget write on that link therefore leaves the handshake half
    /// done — the device never delivers the answer and the next command goes out
    /// of sync, which is why the travel monitor and calibration appeared dead on
    /// wireless. On the raw (wired) link a plain write is already complete.
    pub fn send_app_packet(&self, packet: &[u8; PACKET_SIZE]) -> Result<(), String> {
        if self.framed {
            let _ = self.exchange(packet)?;
            return Ok(());
        }
        self.send_packet(packet)
    }

    /// Write a packet **without waiting for a reply** (raw link only — see
    /// `send_app_packet` for why the framed link cannot use this).
    pub fn send_packet(&self, packet: &[u8; PACKET_SIZE]) -> Result<(), String> {
        if !self.framed {
            let mut msg = Vec::with_capacity(1 + PACKET_SIZE);
            msg.push(REPORT_ID);
            msg.extend_from_slice(packet);
            return self.write_report(&msg);
        }
        for f in self.next_frames(packet) {
            let mut msg = Vec::with_capacity(1 + FRAME_SIZE);
            msg.push(REPORT_ID);
            msg.extend_from_slice(&f);
            self.write_report(&msg)?;
            std::thread::sleep(FRAME_GAP);
        }
        Ok(())
    }

    /// Take the async report packets the reader thread has queued, sending
    /// nothing.
    ///
    /// Used by the trigger page (travel monitor stream + calibration progress):
    /// the device pushes those on its own, there is no per-sample request.
    ///
    /// `timeout == 0` means "non-blocking: take everything queued right now"
    /// (the caller then immediately re-arms the next round, and the reader
    /// thread keeps filling the queue in between). A non-zero `timeout` keeps
    /// the old "collect for at most this long" semantics.
    pub fn drain_event_packets(&self, timeout: Duration) -> Result<Vec<[u8; PACKET_SIZE]>, String> {
        let blocking = !timeout.is_zero();
        let deadline = Instant::now() + timeout;
        let mut out = Vec::new();
        if !self.framed {
            while let Some(buf) = self.next_frame(blocking, deadline)? {
                if buf.len() < PACKET_SIZE {
                    continue;
                }
                let mut p = [0u8; PACKET_SIZE];
                p.copy_from_slice(&buf[..PACKET_SIZE]);
                if is_event(&p) {
                    out.push(p);
                }
            }
            return Ok(out);
        }
        // Framed link: reassemble 5 fragments into a packet, ACKing each one.
        let mut parts: BTreeMap<u8, Vec<u8>> = BTreeMap::new();
        while let Some(buf) = self.next_frame(blocking, deadline)? {
            if buf.first() != Some(&MAGIC) {
                continue;
            }
            let ack = ack_frame(&buf);
            let mut msg = Vec::with_capacity(1 + FRAME_SIZE);
            msg.push(REPORT_ID);
            msg.extend_from_slice(&ack);
            self.write_report(&msg)?;
            let Some(r) = parse_frame(&buf) else {
                continue;
            };
            if !r.ok || r.len == 0 {
                continue;
            }
            if r.idx as usize != parts.len() + 1 {
                continue;
            }
            parts.insert(r.idx, r.data);
            if parts.len() == 5 {
                if let Some(p) = reassemble(&parts) {
                    if is_event(&p) {
                        out.push(p);
                    }
                }
                parts.clear();
            }
        }
        Ok(out)
    }

    /// Send a command and return the fixed-size data area of the reply.    ///
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

    /// `0x9A/<profile>` — onboard profile name. `None` when unnamed
    /// (length byte 0 or 0xff).
    pub fn read_profile_name(&self, profile: u8) -> Result<Option<String>, String> {
        let d = self.read_cmd(0x9A, profile, 56)?;
        let n = d[0] as usize;
        if n == 0 || n == 0xFF || n > 55 {
            return Ok(None);
        }
        Ok(Some(String::from_utf8_lossy(&d[1..1 + n]).to_string()))
    }

    /// `0x1A/<profile>` — write the profile name: `[len, ...UTF-8]`, ≤ 55 bytes.
    pub fn write_profile_name(&self, profile: u8, name: &str) -> Result<(), String> {
        let b = name.as_bytes();
        if b.len() > 55 {
            return Err(format!("配置名过长（{} 字节，上限 55）", b.len()));
        }
        let mut data = Vec::with_capacity(1 + b.len());
        data.push(b.len() as u8);
        data.extend_from_slice(b);
        self.exchange(&build_app_packet(0x1A, profile, &data))?;
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

impl Drop for AulaDevice {
    /// Stop and join the reader thread: its handle must be closed before the
    /// device can be reopened, otherwise `close_device` would leave the
    /// interface held. Worst-case wait is one idle tick (`READER_IDLE_MS`).
    ///
    /// Closing the queue before the join is what keeps this from deadlocking: a
    /// thread parked in `read_frame` (up to a 2.5 s deadline) is woken by the
    /// `notify_all` and sees end-of-stream instead of waiting out its timeout.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.queue.close();
        if let Some(h) = self.reader.take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(n: u32) -> Vec<u8> {
        let mut v = n.to_be_bytes().to_vec();
        v.resize(PACKET_SIZE, 0);
        v
    }

    fn id_of(b: &[u8]) -> u32 {
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    }

    fn pop_id(q: &ReportQueue) -> Option<u32> {
        match q.pop_timeout(Duration::ZERO) {
            Pop::Item(b) => Some(id_of(&b)),
            _ => None,
        }
    }

    /// (a) length is capped at the capacity, (b) the **oldest** reports are the
    /// ones evicted, (c) every eviction is counted.
    #[test]
    fn queue_is_bounded_and_drops_the_oldest() {
        let q = ReportQueue::new();
        let overflow = 10u32;
        let total = MAX_QUEUED_REPORTS as u32 + overflow;
        for i in 0..total {
            q.push(report(i));
        }
        assert_eq!(q.len(), MAX_QUEUED_REPORTS);
        assert_eq!(pop_id(&q), Some(overflow), "survivors start after the evicted head");
        let mut last = None;
        while let Some(i) = pop_id(&q) {
            last = Some(i);
        }
        assert_eq!(last, Some(total - 1), "the newest report is kept");
        assert_eq!(q.dropped(), overflow as u64);
        // Draining an open queue leaves it empty, not closed.
        assert!(matches!(q.pop_timeout(Duration::ZERO), Pop::Empty));
    }

    /// The join in `AulaDevice::drop` must not sit behind a parked consumer.
    #[test]
    fn close_wakes_waiters() {
        let q = Arc::new(ReportQueue::new());
        let waiter = Arc::clone(&q);
        let t = std::thread::spawn(move || waiter.pop_timeout(Duration::from_secs(2)));
        std::thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        q.close();
        assert!(matches!(t.join().unwrap(), Pop::Closed));
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
