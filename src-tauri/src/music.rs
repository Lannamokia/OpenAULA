//! 神光同步：系统音频频谱 → 键盘逐键颜色帧，外加 Windows 主题强调色同步。
//!
//! 分工：Rust 侧只做「WASAPI 回环采集 → FFT → 频段能量 → 键颜色帧」，**完全不碰
//! HID**。前端按刷新率调 [`music_frame`] 取帧，再用已验证的 `set_key_colors`
//! （`0x08/1`）下发。这样后台线程不必争用 `AppState` 的设备 Mutex，也不会重复
//! 打开 HID 句柄。下发的节流在 `src/pages/music.ts`：链路是无线就压低帧率，
//! 上一帧没发完就丢帧（见那里的注释）。
//!
//! 采集走 WASAPI **loopback**：取默认**渲染**端点的 `IAudioClient`，却用
//! `Direction::Capture` 初始化 —— `wasapi` crate 据此加上
//! `AUDCLNT_STREAMFLAGS_LOOPBACK`，于是读到的就是系统正在播放的声音。

use std::collections::BTreeMap;
use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::{Deserialize, Serialize};
use wasapi::{
    initialize_mta, AudioCaptureClient, AudioClient, Device, DeviceEnumerator, Direction, Handle,
    SampleType, StreamMode, WaveFormat,
};

use crate::lighting::{KeyColor, Rgb};

/// FFT 窗长（48 kHz 下约 43 ms）。
const FFT_SIZE: usize = 2048;
/// 相邻两次 FFT 的步进（= 窗长的一半，约 47 次/秒）。
const HOP: usize = FFT_SIZE / 2;
/// 频谱范围。
const F_MIN: f32 = 40.0;
const F_MAX: f32 = 16_000.0;
/// 频段能量的分贝下限：低于它算静音。
const DB_FLOOR: f32 = -75.0;
/// 归一化能量低于此值的键直接熄灭。
const LEVEL_MIN: f32 = 0.02;

pub const MIN_BANDS: u8 = 4;
pub const MAX_BANDS: u8 = 24;

// --- 全局引擎 -----------------------------------------------------------------

/// 采集线程与它发布的共享状态。全部用 `Arc` 单独克隆给线程，线程不碰这个结构。
struct Engine {
    thread: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    levels: Arc<Mutex<Vec<f32>>>,
    peak: Arc<Mutex<f32>>,
    frames: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
    bands: u8,
}

impl Engine {
    fn new() -> Self {
        Self {
            thread: None,
            stop: Arc::new(AtomicBool::new(false)),
            levels: Arc::new(Mutex::new(Vec::new())),
            peak: Arc::new(Mutex::new(0.0)),
            frames: Arc::new(AtomicU64::new(0)),
            error: Arc::new(Mutex::new(None)),
            bands: 0,
        }
    }
}

fn engine() -> &'static Mutex<Engine> {
    static ENGINE: OnceLock<Mutex<Engine>> = OnceLock::new();
    ENGINE.get_or_init(|| Mutex::new(Engine::new()))
}

fn lock_engine() -> Result<std::sync::MutexGuard<'static, Engine>, String> {
    engine().lock().map_err(|e| format!("音频引擎锁已损坏: {e}"))
}

/// 线程还活着才算在跑（出错退出的线程句柄会留下，但 `is_finished()` 为真）。
fn is_running(e: &Engine) -> bool {
    e.thread.as_ref().is_some_and(|h| !h.is_finished())
}

fn stop_locked(e: &mut Engine) {
    e.stop.store(true, Ordering::Relaxed);
    if let Some(h) = e.thread.take() {
        let _ = h.join();
    }
    e.bands = 0;
    if let Ok(mut l) = e.levels.lock() {
        l.clear();
    }
    if let Ok(mut p) = e.peak.lock() {
        *p = 0.0;
    }
}

fn start_locked(e: &mut Engine, bands: u8) -> Result<(), String> {
    let n = bands as usize;
    let stop = Arc::new(AtomicBool::new(false));
    let levels = Arc::new(Mutex::new(vec![0.0f32; n]));
    let peak = Arc::new(Mutex::new(0.0f32));
    let frames = Arc::new(AtomicU64::new(0));
    let error = Arc::new(Mutex::new(None::<String>));
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    let handle = {
        let (stop, levels, peak, frames, error) = (
            stop.clone(),
            levels.clone(),
            peak.clone(),
            frames.clone(),
            error.clone(),
        );
        std::thread::Builder::new()
            .name("aula-music".into())
            .spawn(move || audio_thread(n, stop, levels, peak, frames, error, tx))
            .map_err(|e| format!("启动音频线程失败: {e}"))?
    };

    e.thread = Some(handle);
    e.stop = stop;
    e.levels = levels;
    e.peak = peak;
    e.frames = frames;
    e.error = error;
    e.bands = bands;

    // 打开音频设备是同步的：等线程回一个结果，好在 UI 上立刻报错（超时按成功处理）。
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) | Err(mpsc::RecvTimeoutError::Timeout) => Ok(()),
        Ok(Err(msg)) => {
            if let Ok(mut err) = e.error.lock() {
                *err = Some(msg.clone());
            }
            Err(msg)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("音频线程启动后立即退出".into()),
    }
}

type LevelSink = Arc<Mutex<Vec<f32>>>;

fn audio_thread(
    bands: usize,
    stop: Arc<AtomicBool>,
    levels: LevelSink,
    peak: Arc<Mutex<f32>>,
    frames: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
    ready: mpsc::Sender<Result<(), String>>,
) {
    let capture = match Capture::open() {
        Ok(c) => {
            let _ = ready.send(Ok(()));
            c
        }
        Err(msg) => {
            let _ = ready.send(Err(msg));
            return;
        }
    };
    let mut spectrum = Spectrum::new(capture.sample_rate as f32, bands);
    if let Err(msg) = capture.run(&stop, &mut spectrum, &levels, &peak, &frames) {
        if let Ok(mut err) = error.lock() {
            *err = Some(msg);
        }
    }
    stop.store(true, Ordering::Relaxed);
}

// --- WASAPI 回环采集 -----------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum SampleKind {
    F32,
    I16,
    I24,
    I32,
}

impl SampleKind {
    fn from_format(f: &WaveFormat) -> Result<Self, String> {
        let bits = f.get_bitspersample();
        match (f.get_subformat(), bits) {
            (Ok(SampleType::Float), 32) => Ok(SampleKind::F32),
            (Ok(SampleType::Int), 16) => Ok(SampleKind::I16),
            (Ok(SampleType::Int), 24) => Ok(SampleKind::I24),
            (Ok(SampleType::Int), 32) => Ok(SampleKind::I32),
            (Ok(k), b) => Err(format!("不支持的采样格式: {k:?} / {b} bit")),
            (Err(e), _) => Err(format!("不支持的采样格式: {e}")),
        }
    }

    fn bytes(self) -> usize {
        match self {
            SampleKind::F32 | SampleKind::I32 => 4,
            SampleKind::I16 => 2,
            SampleKind::I24 => 3,
        }
    }

    /// 单个样本 → f32（满量程 = ±1.0）。
    fn sample(self, b: &[u8]) -> f32 {
        match self {
            SampleKind::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            SampleKind::I16 => i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0,
            SampleKind::I24 => {
                let hi = if b[2] & 0x80 != 0 { 0xff } else { 0x00 };
                i32::from_le_bytes([b[0], b[1], b[2], hi]) as f32 / 8_388_608.0
            }
            SampleKind::I32 => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
        }
    }
}

struct Capture {
    audio: AudioClient,
    client: AudioCaptureClient,
    event: Handle,
    kind: SampleKind,
    channels: usize,
    blockalign: usize,
    sample_rate: u32,
    buf: Vec<u8>,
}

impl Capture {
    fn open() -> Result<Self, String> {
        initialize_mta()
            .ok()
            .map_err(|e| format!("COM 初始化失败: {e}"))?;
        let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
        // 回环采集的对象是默认**播放**设备，只是按 Capture 方向初始化。
        let device = enumerator
            .get_default_device(&Direction::Render)
            .map_err(|e| format!("找不到默认播放设备: {e}"))?;
        match open_on(&device, false) {
            Ok(c) => Ok(c),
            // 少数设备不接受「回环 + 原样格式」，退回让音频引擎做重采样。
            Err(first) => open_on(&device, true)
                .map_err(|second| format!("回环采集初始化失败: {first}；开启 autoconvert 重试仍失败: {second}")),
        }
    }

    fn run(
        &self,
        stop: &AtomicBool,
        spectrum: &mut Spectrum,
        levels: &LevelSink,
        peak: &Mutex<f32>,
        frames: &AtomicU64,
    ) -> Result<(), String> {
        let mut buf = self.buf.clone();
        while !stop.load(Ordering::Relaxed) {
            // 超时（拿不到事件）不算错误：可能是此刻没有任何声音。
            let _ = self.event.wait_for_event(200);
            let before = spectrum.produced;
            while !stop.load(Ordering::Relaxed) {
                let (n, _) = self
                    .client
                    .read_from_device(&mut buf)
                    .map_err(|e| format!("读取音频数据失败: {e}"))?;
                if n == 0 {
                    break;
                }
                spectrum.push_pcm(&buf[..n as usize * self.blockalign], self.kind, self.channels);
            }
            if spectrum.produced != before {
                if let Ok(mut l) = levels.lock() {
                    l.clear();
                    l.extend_from_slice(&spectrum.level);
                }
                if let Ok(mut p) = peak.lock() {
                    *p = spectrum.peak;
                }
                frames.store(spectrum.produced, Ordering::Relaxed);
            }
        }
        let _ = self.audio.stop_stream();
        Ok(())
    }
}

fn open_on(device: &Device, autoconvert: bool) -> Result<Capture, String> {
    let mut audio = device.get_iaudioclient().map_err(|e| e.to_string())?;
    // 回环采集拿到的是设备混音格式，直接照用最稳。
    let format = audio.get_mixformat().map_err(|e| e.to_string())?;
    let kind = SampleKind::from_format(&format)?;
    let channels = format.get_nchannels() as usize;
    let blockalign = format.get_blockalign() as usize;
    if channels == 0 || blockalign == 0 {
        return Err(format!("设备格式异常: {channels} 声道 / {blockalign} 字节帧"));
    }
    let (_, min_period) = audio
        .get_device_period()
        .map_err(|e| format!("读取设备周期失败: {e}"))?;
    let mode = StreamMode::EventsShared {
        autoconvert,
        buffer_duration_hns: min_period,
    };
    audio
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|e| e.to_string())?;
    let event = audio.set_get_eventhandle().map_err(|e| e.to_string())?;
    let client = audio.get_audiocaptureclient().map_err(|e| e.to_string())?;
    let buffer_frames = audio.get_buffer_size().map_err(|e| e.to_string())?.max(4096) as usize;
    audio.start_stream().map_err(|e| e.to_string())?;
    Ok(Capture {
        audio,
        client,
        event,
        kind,
        channels,
        blockalign,
        sample_rate: format.get_samplespersec(),
        buf: vec![0u8; blockalign * buffer_frames],
    })
}

// --- 频谱分析 -----------------------------------------------------------------

struct Spectrum {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    /// 待处理的多声道混合单声道样本。
    mono: Vec<f32>,
    bands: usize,
    /// 频段边界（FFT bin 下标，长度 = bands + 1）。
    edges: Vec<usize>,
    /// 时间平滑后的各频段能量 0..1。
    level: Vec<f32>,
    peak: f32,
    produced: u64,
}

impl Spectrum {
    fn new(sample_rate: f32, bands: usize) -> Self {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        let window = (0..FFT_SIZE)
            .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (FFT_SIZE - 1) as f32).cos())
            .collect();
        Self {
            fft,
            window,
            scratch: vec![Complex::new(0.0, 0.0); FFT_SIZE],
            mono: Vec::with_capacity(FFT_SIZE * 4),
            bands,
            edges: band_edges(bands, sample_rate),
            level: vec![0.0; bands],
            peak: 0.0,
            produced: 0,
        }
    }

    fn push_pcm(&mut self, bytes: &[u8], kind: SampleKind, channels: usize) {
        let step = kind.bytes();
        let frame_bytes = step * channels;
        for frame in bytes.chunks_exact(frame_bytes) {
            let mut sum = 0.0f32;
            for c in 0..channels {
                sum += kind.sample(&frame[c * step..c * step + step]);
            }
            self.mono.push(sum / channels as f32);
        }
        while self.mono.len() >= FFT_SIZE {
            self.analyze();
            self.mono.drain(..HOP);
        }
    }

    fn analyze(&mut self) {
        for (i, s) in self.mono[..FFT_SIZE].iter().enumerate() {
            self.scratch[i] = Complex::new(s * self.window[i], 0.0);
        }
        let fft = self.fft.clone();
        fft.process(&mut self.scratch);
        for b in 0..self.bands {
            let (lo, hi) = (self.edges[b], self.edges[b + 1]);
            let mut sum_sq = 0.0f32;
            for k in lo..hi {
                sum_sq += self.scratch[k].norm_sqr();
            }
            // 满量程正弦经 Hann 窗后在单个 bin 上给出 |X| ≈ N/4，据此归一化到 ~0..1。
            let amp = sum_sq.sqrt() / (FFT_SIZE as f32 * 0.25);
            let db = 20.0 * (amp + 1e-9).log10();
            let target = ((db - DB_FLOOR) / -DB_FLOOR).clamp(0.0, 1.0);
            // 快攻慢放：起音跟得上，余音衰减慢，灯不闪。
            let prev = self.level[b];
            let a = if target > prev { 0.6 } else { 0.15 };
            self.level[b] = prev + (target - prev) * a;
        }
        self.peak = self.level.iter().copied().fold(0.0f32, f32::max);
        self.produced += 1;
    }
}

/// 对数分布的频段边界；保证每段至少占 1 个 bin 且单调递增。
fn band_edges(bands: usize, sample_rate: f32) -> Vec<usize> {
    let nbin = FFT_SIZE / 2;
    let ratio = F_MAX / F_MIN;
    let mut edges = Vec::with_capacity(bands + 1);
    edges.push(1usize);
    for i in 1..=bands {
        let f = F_MIN * ratio.powf(i as f32 / bands as f32);
        let bin = (f * FFT_SIZE as f32 / sample_rate).round() as usize;
        let prev = *edges.last().unwrap();
        edges.push(bin.clamp(prev + 1, nbin));
    }
    edges
}

// --- 频段能量 → 键颜色 ---------------------------------------------------------

#[derive(Deserialize)]
struct LayoutKey {
    #[serde(rename = "keyValue")]
    key_value: u16,
    col: i32,
    row: i32,
}

fn layout() -> &'static Vec<LayoutKey> {
    static LAYOUT: OnceLock<Vec<LayoutKey>> = OnceLock::new();
    LAYOUT.get_or_init(|| {
        serde_json::from_str(include_str!("../data/layout68.json")).unwrap_or_default()
    })
}

/// 键区的物理列（按 `col` 从左到右），列内**自下而上**排列 —— 布局数据里
/// `y` 随 `row` 增大而增大（row 4 是贴身体的那一排），所以 `row` 大的排在前面，
/// 每列的第 0 个就是最靠近身体的键。柱状频谱从这里往上长。
fn columns() -> &'static Vec<(i32, Vec<(i32, u16)>)> {
    static COLS: OnceLock<Vec<(i32, Vec<(i32, u16)>)>> = OnceLock::new();
    COLS.get_or_init(|| {
        let mut map: BTreeMap<i32, Vec<(i32, u16)>> = BTreeMap::new();
        for k in layout() {
            map.entry(k.col).or_default().push((k.row, k.key_value));
        }
        map.into_iter()
            .map(|(col, mut keys)| {
                keys.sort_by(|a, b| b.0.cmp(&a.0));
                (col, keys)
            })
            .collect()
    })
}

/// 一列对应的能量。频段数 ≥ 列数时把该列覆盖到的几段**合并**（取最响的一段，
/// 峰值不被平均掉）；频段数 < 列数时一段**重复**铺给多列。
fn column_energy(bands: &[f32], col: usize, cols: usize) -> f32 {
    let n = bands.len();
    if n == 0 || cols == 0 {
        return 0.0;
    }
    if n < cols {
        return bands[(col * n / cols).min(n - 1)];
    }
    let lo = col * n / cols;
    let hi = ((col + 1) * n).div_ceil(cols).min(n);
    bands[lo..hi].iter().copied().fold(0.0f32, f32::max)
}

/// 列 → 色相：低频（左）偏红、高频（右）偏紫，像音乐软件的频谱柱。
fn column_hue(col: usize, cols: usize) -> f32 {
    if cols <= 1 {
        return 200.0;
    }
    8.0 + 288.0 * (col as f32 / (cols - 1) as f32)
}

/// 柱子的颜色：色相 = 频率位置（低频偏红 → 高频偏紫），亮度 = 这一列的能量。
///
/// 整列同色是**刻意的**：逐键渐变会让一帧里的不同颜色数涨到几十个，而下发的
/// 通道按颜色聚类整包发送，无线链路上一个包就是一个完整往返 —— 一帧多包就是
/// 几百毫秒的延迟。整列同色时一帧最多 16 个颜色（15 列 + 黑），通常只要 1 个包。
fn column_color(hue: f32, h: f32) -> Rgb {
    hsl_to_rgb(hue, 0.95, (0.16 + 0.46 * h).clamp(0.05, 0.72))
}

/// 当前频段能量 → 整键盘 68 键的颜色帧：每列一根从底部往上长的柱子，
/// 柱子高度 = 该列能量，未达到高度的键全黑。
fn band_frame(bands: &[f32], gain: f32) -> Vec<KeyColor> {
    let cols = columns();
    if cols.is_empty() {
        return Vec::new();
    }
    let gain = if gain.is_finite() && gain > 0.0 { gain } else { 1.0 };
    let mut out = Vec::with_capacity(layout().len());
    for (j, (_, keys)) in cols.iter().enumerate() {
        let raw = column_energy(bands, j, cols.len()) * gain;
        let h = if raw.is_finite() { raw.clamp(0.0, 1.0) } else { 0.0 };
        // 有一点能量至少点亮最底下一颗，静音（低于阈值）则整列全黑。
        let lit = if h < LEVEL_MIN {
            0
        } else {
            (h * keys.len() as f32).ceil() as usize
        };
        let color = column_color(column_hue(j, cols.len()), h);
        for (i, (_, id)) in keys.iter().enumerate() {
            let color = if i < lit { color } else { Rgb { r: 0, g: 0, b: 0 } };
            out.push(KeyColor { id: *id, color });
        }
    }
    out
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> Rgb {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h.rem_euclid(360.0) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let to = |v: f32| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    Rgb { r: to(r), g: to(g), b: to(b) }
}

// --- Windows 主题强调色 --------------------------------------------------------

const DWM_KEY: &str = r"Software\Microsoft\Windows\DWM";

/// 读 `HKCU\...\DWM\AccentColor`（DWORD，字节序 ABGR → RGB）。
/// 该值缺失时退回 `ColorizationColor`（DWORD，字节序 ARGB）。
pub(crate) fn accent_color() -> Result<Rgb, String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;
    let dwm = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(DWM_KEY, KEY_READ)
        .map_err(|e| format!("打开注册表 {DWM_KEY} 失败: {e}"))?;
    if let Ok(v) = dwm.get_value::<u32, _>("AccentColor") {
        return Ok(Rgb {
            r: (v & 0xff) as u8,
            g: ((v >> 8) & 0xff) as u8,
            b: ((v >> 16) & 0xff) as u8,
        });
    }
    let v = dwm
        .get_value::<u32, _>("ColorizationColor")
        .map_err(|e| format!("读取 AccentColor / ColorizationColor 失败: {e}"))?;
    Ok(Rgb {
        r: ((v >> 16) & 0xff) as u8,
        g: ((v >> 8) & 0xff) as u8,
        b: (v & 0xff) as u8,
    })
}

// --- Tauri 命令 ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct MusicStatus {
    pub running: bool,
    pub frames: u64,
    pub bands: Vec<f32>,
    pub peak: f32,
    pub error: Option<String>,
}

/// 起后台线程做回环采集 + FFT。`bands` 会夹到 4..24；已在跑且频段数不变时是空操作。
#[tauri::command]
pub fn music_start(bands: u8) -> Result<(), String> {
    let bands = bands.clamp(MIN_BANDS, MAX_BANDS);
    let mut e = lock_engine()?;
    if is_running(&e) {
        if e.bands == bands {
            return Ok(());
        }
        stop_locked(&mut e);
    } else if e.thread.is_some() {
        // 线程已因错误退出：清掉陈旧句柄再重启。
        stop_locked(&mut e);
    }
    start_locked(&mut e, bands)
}

#[tauri::command]
pub fn music_stop() -> Result<(), String> {
    let mut e = lock_engine()?;
    stop_locked(&mut e);
    Ok(())
}

#[tauri::command]
pub fn music_status() -> Result<MusicStatus, String> {
    let e = lock_engine()?;
    let running = is_running(&e);
    let error = e.error.lock().map_err(|x| x.to_string())?.clone();
    let mut status = MusicStatus {
        running,
        frames: 0,
        bands: Vec::new(),
        peak: 0.0,
        error,
    };
    if running {
        status.frames = e.frames.load(Ordering::Relaxed);
        status.bands = e.levels.lock().map_err(|x| x.to_string())?.clone();
        status.peak = *e.peak.lock().map_err(|x| x.to_string())?;
    }
    Ok(status)
}

/// 当前频段能量 → 整键盘 68 键的颜色帧（`gain` 是前端增益倍率）。
#[tauri::command]
pub fn music_frame(gain: f32) -> Result<Vec<KeyColor>, String> {
    let e = lock_engine()?;
    let bands = e.levels.lock().map_err(|e| e.to_string())?.clone();
    Ok(band_frame(&bands, gain))
}

#[tauri::command]
pub fn windows_accent_color() -> Result<Rgb, String> {
    accent_color()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 布局里某键的 `(col, row)`。
    fn key_pos(id: u16) -> (i32, i32) {
        let k = layout().iter().find(|k| k.key_value == id).expect("键 id 在布局里");
        (k.col, k.row)
    }

    /// 只有最低频段满格：只有最左那根柱子亮（含它最底下的键），其余全黑。
    /// 频段数取上限 24 ≥ 列数 15，最低频段才不会被分给多列。
    #[test]
    fn bass_only_lights_the_leftmost_column_from_the_bottom() {
        let mut bands = vec![0.0f32; MAX_BANDS as usize];
        bands[0] = 1.0;
        let frame = band_frame(&bands, 1.0);
        assert_eq!(frame.len(), layout().len());

        let left = columns()[0].0;
        let bottom_id = columns()[0].1[0].1;
        for kc in &frame {
            let (col, _) = key_pos(kc.id);
            if col == left {
                assert_ne!(kc.color, Rgb { r: 0, g: 0, b: 0 }, "左列应亮: id {}", kc.id);
            } else {
                assert_eq!(kc.color, Rgb { r: 0, g: 0, b: 0 }, "其余列应全黑: id {}", kc.id);
            }
        }
        // 柱子的根在列底（布局里 row 最大的那一排）。
        let (_, row) = key_pos(bottom_id);
        assert_eq!(row, columns()[0].1.iter().map(|(r, _)| *r).max().unwrap());
    }

    /// 高度从底部往上长：能量只够点亮最底下一颗时，上面的键必须是黑的。
    #[test]
    fn column_height_rises_from_the_bottom() {
        let cols = columns()[0].1.len() as f32;
        let mut bands = vec![0.0f32; MAX_BANDS as usize];
        bands[0] = 1.0 / (2.0 * cols);
        let frame = band_frame(&bands, 1.0);
        let left = columns()[0].0;
        let lit: Vec<u16> = frame
            .iter()
            .filter(|k| k.color != Rgb { r: 0, g: 0, b: 0 })
            .map(|k| k.id)
            .collect();
        assert_eq!(lit.len(), 1, "只应点亮最底下一颗");
        assert_eq!(key_pos(lit[0]), (left, columns()[0].1[0].0));
    }

    /// 静音（低于阈值）与 0 段输入都不该点亮任何键。
    #[test]
    fn silence_and_empty_input_are_black() {
        let black = Rgb { r: 0, g: 0, b: 0 };
        for bands in [vec![0.0f32; MAX_BANDS as usize], Vec::new()] {
            assert!(band_frame(&bands, 1.0).iter().all(|k| k.color == black));
        }
        // 增益为 0 / NaN / 负数时按 1× 处理，而不是把整块键盘打黑。
        let mut loud = vec![0.0f32; MAX_BANDS as usize];
        loud[0] = 1.0;
        assert!(band_frame(&loud, 0.0).iter().any(|k| k.color != black));
    }

    /// 发色数是速率的关键：整列同色 + 一种黑，一帧最多「列数 + 1」个颜色，
    /// 载荷因此远在上限（255 字节）之内，不会触发聚类合并。
    #[test]
    fn a_frame_uses_one_color_per_column() {
        let colors_of = |frame: &[KeyColor]| {
            let mut v: Vec<Rgb> = frame.iter().map(|k| k.color).collect();
            v.sort_by_key(|c| (c.r, c.g, c.b));
            v.dedup();
            v.len()
        };
        // 全亮 = 最坏情况。
        let all = vec![1.0f32; MAX_BANDS as usize];
        let frame = band_frame(&all, 1.0);
        let groups = colors_of(&frame);
        assert!(groups <= columns().len() + 1, "{groups} 个颜色超过 列数 + 黑");
        assert!(4 * groups + frame.len() <= 255, "一帧载荷超过单条命令的上限");
        // 常见情形（低半段有声音）要能塞进两个包，无线电上一帧就是两个往返。
        let mut half = vec![0.0f32; MAX_BANDS as usize];
        for b in half.iter_mut().take(MAX_BANDS as usize / 2) {
            *b = 1.0;
        }
        let hf = band_frame(&half, 1.0);
        assert!(4 * colors_of(&hf) + hf.len() <= 112, "常见帧应能塞进 2 个包");
    }

    /// 频段数 < 列数时一段要铺给多列（重复），最左列仍属最低频段。
    #[test]
    fn fewer_bands_than_columns_repeat_each_band() {
        let mut bands = vec![0.0f32; MIN_BANDS as usize];
        bands[0] = 1.0;
        let frame = band_frame(&bands, 1.0);
        let left = columns()[0].0;
        assert!(frame
            .iter()
            .any(|k| key_pos(k.id).0 == left && k.color != Rgb { r: 0, g: 0, b: 0 }));
        // 高频段没能量 → 最右列必黑。
        let right = columns().last().unwrap().0;
        assert!(frame
            .iter()
            .filter(|k| key_pos(k.id).0 == right)
            .all(|k| k.color == Rgb { r: 0, g: 0, b: 0 }));
    }

    /// 频段 → 列的分组既不漏段也不越界。
    #[test]
    fn column_energy_covers_every_band_without_panicking() {
        let cols = columns().len();
        let mut bands = vec![0.0f32; MAX_BANDS as usize];
        bands[MAX_BANDS as usize - 1] = 1.0;
        for j in 0..cols {
            assert!(column_energy(&bands, j, cols).is_finite());
        }
        // 最高频段只影响它自己那一列：最右列亮，最左列黑。
        let frame = band_frame(&bands, 1.0);
        let left = columns()[0].0;
        let right = columns().last().unwrap().0;
        assert!(frame.iter().filter(|k| key_pos(k.id).0 == left).all(|k| k.color == Rgb { r: 0, g: 0, b: 0 }));
        assert!(frame.iter().filter(|k| key_pos(k.id).0 == right).any(|k| k.color != Rgb { r: 0, g: 0, b: 0 }));
    }
}
