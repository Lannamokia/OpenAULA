import { invoke } from "@tauri-apps/api/core";

export interface DeviceDesc {
  path: string;
  vendor_id: number;
  product_id: number;
  usage_page: number;
  usage: number;
  manufacturer: string | null;
  product: string | null;
  serial: string | null;
  framed: boolean;
}

export interface Battery {
  level: number;
  flags: number;
  charging: boolean;
}

export interface DeviceStatus {
  product: string | null;
  manufacturer: string | null;
  vendor_id: number;
  product_id: number;
  framed: boolean;
  uuid: string | null;
  firmware: string | null;
  battery: Battery | null;
  profile: number | null;
}

export interface KeyEntry {
  id: number;
  keycode: number;
}

export interface RawResult {
  request: string;
  response: string | null;
}

// --- 宏（docs/commands.md §5）------------------------------------------------

export interface MacroAction {
  /** bit7: 0 = 按下, 1 = 抬起。 */
  kind: number;
  /** bits4-6: 0 = 键盘, 1 = 鼠标, 2 = 多媒体。 */
  device: number;
  /** 20 位毫秒延时（0..0xFFFFF）。 */
  delay: number;
  /** 1 字节键码。 */
  keycode: number;
}

export interface Macro {
  name: string;
  actions: MacroAction[];
}

export interface MacroRegion {
  /** `0x82/0` 宏区容量（本机 4096）。 */
  capacity: number;
  /** 本次实际读回的字节数。 */
  total_len: number;
  /** 头表长度（= 4 × 宏条数）。 */
  header_len: number;
  macros: Macro[];
  /** 整段都是 0xff（擦除态）= 没有宏。 */
  empty: boolean;
  /** 原始区域字节（hex），用于核对。 */
  raw: string;
}

// --- 高级键（docs/commands.md §6）--------------------------------------------

export interface AdvancedGroup {
  keycode: number;
  /** MPT：距离，0.01mm 单位（UI mm × 100）。 */
  distance?: number | null;
  /** DKS：4 个触发段字节。 */
  triggers?: number[] | null;
}

export interface AdvancedKey {
  /** 0 = 空槽, 1..7 = TGL/MT/DKS/SOCD/MPT/END/RS。 */
  kind: number;
  id: number;
  ids: number[];
  keycode: number;
  hold_keycode: number;
  click_keycode: number;
  delay: number;
  depths: number[];
  groups: AdvancedGroup[];
  response_mode: number;
}

export interface AdvancedEntry {
  id: number;
  /** null = 已占用 id 但类型为空（NONE）。 */
  key: AdvancedKey | null;
}

// --- 磁轴触发 / 性能（docs/commands.md §7）-----------------------------------

export interface RapidTrigger {
  id: number;
  /** 0/1：该键的快速触发开关。 */
  enable: number;
  /** 协议单位（mm × 200，见 TriggerCaps.travel_precision）。 */
  press: number;
  release: number;
}

export interface KeyTravel {
  id: number;
  /** 协议单位（mm × 200）。 */
  travel: number;
}

export interface SwitchType {
  id: number;
  switch_type: number;
}

export interface SafeArea {
  id: number;
  /** 顶部死区，协议单位。 */
  top: number;
  /** 底部死区，协议单位。 */
  bottom: number;
  enable: number;
}

export interface AdRange {
  id: number;
  max: number;
  min: number;
}

export interface TravelSample {
  id: number;
  distance: number;
  press: boolean;
  ad: number;
}

export interface CalibrationSample {
  id: number;
  ad: number;
  min: number;
  /** 设备用该记录 bit15 标记「此键校准完成」——网页就是按这个把键染色的。 */
  finished: boolean;
}

export interface TriggerCaps {
  /** 一个协议单位 = travel_precision 微米（本机 5 → 0.005mm，即 mm × 200）。 */
  travel_precision: number;
  min_rapid_trigger: number;
  supported_switches: string;
  switch_ids: number[];
  advanced_key_types: number;
  /** 开关位图非空 ⇒ 磁轴键盘。 */
  magnetic: boolean;
}

export interface TriggerEvents {
  travel: TravelSample[];
  calibration: CalibrationSample[];
}

// --- 设备级开关（docs/commands.md §1.2）--------------------------------------

export interface DeviceSettings {
  /** 0 = Windows，1 = macOS。 */
  os_mode: number;
  sleep_time: number;
  win_key_lock: boolean;
  /** 0=1K 1=500 2=250 3=125 4=8K 5=4K 6=2K。 */
  polling_rate: number;
  combo_optimization: boolean;
  adaptive_calibration: boolean;
  /** 0=Normal 1=Leading 2=Trailing 3=Auto。 */
  debounce_mode: number;
  debounce_time: number;
  low_power_mode: boolean;
  wasd_swapped: boolean;
  side_light_sync: boolean;
  sleep_info_raw: number[];
}

export interface SettingsCaps {
  low_power_supported: boolean;
  wireless_dedicated: boolean;
  supported_switches: string;
}

export const POLLING_RATES: { value: number; label: string }[] = [
  { value: 0, label: "1KHz" },
  { value: 1, label: "500Hz" },
  { value: 2, label: "250Hz" },
  { value: 3, label: "125Hz" },
  { value: 4, label: "8KHz" },
  { value: 5, label: "4KHz" },
  { value: 6, label: "2KHz" },
];

export const DEBOUNCE_MODES: { value: number; label: string }[] = [
  { value: 0, label: "Normal" },
  { value: 1, label: "Leading" },
  { value: 2, label: "Trailing" },
  { value: 3, label: "Auto" },
];



export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface ZoneEffect {
  effect_id: number;
  color_index: number;
  color: Rgb;
  brightness: number;
  speed: number;
  direction: number | null;
}

export interface LightingCaps {
  music_main: boolean;
  music_spectrum: boolean;
  music_side: boolean;
  side_light: boolean;
  side_beads: number;
  logo_light: boolean;
  lightbox_rows: number;
  lightbox_cols: number;
  effect_bitmap: number;
  direction_supported: boolean;
  raw: string;
}

export interface ZoneState {
  base: number;
  name: string;
  supported: boolean;
  effect: ZoneEffect | null;
  error: string | null;
}

export interface LightingOverview {
  caps: LightingCaps | null;
  zones: ZoneState[];
}

export interface KeyColor {
  id: number;
  color: Rgb;
}

export const api = {
  listDevices: () => invoke<DeviceDesc[]>("list_devices"),
  openDevice: (path?: string) =>
    invoke<DeviceDesc>("open_device", { path: path ?? null }),
  closeDevice: () => invoke<void>("close_device"),
  deviceStatus: () => invoke<DeviceStatus>("device_status"),
  readKeymap: (layer: number, system: number, ids: number[]) =>
    invoke<KeyEntry[]>("read_keymap", { layer, system, ids }),
  writeKeymap: (layer: number, system: number, entries: KeyEntry[]) =>
    invoke<void>("write_keymap", { layer, system, entries }),
  getProfile: () => invoke<number>("get_profile"),
  switchProfile: (n: number) => invoke<void>("switch_profile", { n }),
  readProfileName: (profile: number) =>
    invoke<string | null>("read_profile_name", { profile }),
  writeProfileName: (profile: number, name: string) =>
    invoke<void>("write_profile_name", { profile, name }),
  readMacroCapacity: () => invoke<number>("read_macro_capacity"),
  /** 读整段宏区（含解析）。 */
  readMacroSet: () => invoke<MacroRegion>("read_macro_set"),
  /** 整段回写；返回写入字节数。 */
  writeMacroSet: (macros: Macro[]) =>
    invoke<number>("write_macro_set", { macros }),
  /** 只读原始区域 hex（调试用）。 */
  readMacroRaw: (totalLen: number) =>
    invoke<string>("read_macro_raw", { totalLen }),
  readAdvanced: (layer: number, system: number) =>
    invoke<AdvancedEntry[]>("read_advanced", { layer, system }),
  readAdvancedKey: (layer: number, system: number, id: number) =>
    invoke<AdvancedKey | null>("read_advanced_key", { layer, system, id }),
  setAdvancedKey: (layer: number, system: number, key: AdvancedKey) =>
    invoke<void>("set_advanced_key", { layer, system, key }),
  deleteAdvancedKey2: (layer: number, system: number, id: number) =>
    invoke<void>("delete_advanced_key2", { layer, system, id }),
  previewAdvanced: (key: AdvancedKey) =>
    invoke<string>("preview_advanced", { key }),
  readMacros: (totalLen: number) =>
    invoke<string>("read_macros", { totalLen }),
  writeAdvancedKey: (
    layer: number,
    system: number,
    keyType: number,
    data: number[],
  ) =>
    invoke<void>("write_advanced_key", { layer, system, keyType, data }),
  deleteAdvancedKey: (layer: number, system: number, id: number) =>
    invoke<void>("delete_advanced_key", { layer, system, id }),
  rawExchange: (cmd: number, param: number, data: string) =>
    invoke<RawResult>("raw_exchange", { cmd, param, data }),
  lightingOverview: () => invoke<LightingOverview>("lighting_overview"),
  setZoneEffect: (base: number, effect: ZoneEffect) =>
    invoke<void>("set_zone_effect", { base, effect }),
  setFullKeysRgb: (color: Rgb) =>
    invoke<void>("set_full_keys_rgb", { color }),
  setKeyColors: (entries: KeyColor[]) =>
    invoke<void>("set_key_colors", { entries }),
  setLightboxColors: (colors: Rgb[]) =>
    invoke<void>("set_lightbox_colors", { colors }),
  /** `0x06/0` — 把逐键颜色持久化进板载自定义灯区（effectId 19「自定义」）。 */
  writeCustomColors: (entries: KeyColor[]) =>
    invoke<void>("write_custom_colors", { entries }),
  /** `0x86/0` — 读单键的已存自定义颜色（固件多 id 批量读会错位，只能逐个读）。 */
  readCustomColor: (id: number) =>
    invoke<Rgb>("read_custom_color", { id }),
  // --- 神光同步（WASAPI 回环频谱 + Windows 主题色）----------------------------
  /** 起后台线程采集系统输出并做 FFT；`bands` 会夹到 4..24。 */
  musicStart: (bands: number) => invoke<void>("music_start", { bands }),
  musicStop: () => invoke<void>("music_stop"),
  musicStatus: () => invoke<MusicStatus>("music_status"),
  /** 当前频段能量 → 整键盘 68 键颜色帧（不下发，交给 setKeyColors）。 */
  musicFrame: (gain: number) => invoke<KeyColor[]>("music_frame", { gain }),
  /** Windows 主题强调色 → 整键盘单色帧。 */
  musicAccentFrame: () => invoke<KeyColor[]>("music_accent_frame"),
  windowsAccentColor: () => invoke<Rgb>("windows_accent_color"),

  // --- 磁轴触发 / 性能（docs/commands.md §7）---------------------------------
  triggerCaps: () => invoke<TriggerCaps>("trigger_caps"),
  readRapidTriggers: (layer: number, system: number, ids: number[]) =>
    invoke<RapidTrigger[]>("read_rapid_triggers", { layer, system, ids }),
  writeRapidTriggers: (layer: number, system: number, list: RapidTrigger[]) =>
    invoke<void>("write_rapid_triggers", { layer, system, list }),
  readKeyTravel: (layer: number, system: number, ids: number[]) =>
    invoke<KeyTravel[]>("read_key_travel", { layer, system, ids }),
  writeKeyTravel: (layer: number, system: number, list: KeyTravel[]) =>
    invoke<void>("write_key_travel", { layer, system, list }),
  readSwitchTypes: (ids: number[]) => invoke<SwitchType[]>("read_switch_types", { ids }),
  writeSwitchTypes: (list: SwitchType[]) => invoke<void>("write_switch_types", { list }),
  readSafeArea: (ids: number[]) => invoke<SafeArea[]>("read_safe_area", { ids }),
  writeSafeArea: (list: SafeArea[]) => invoke<void>("write_safe_area", { list }),
  readAdRange: (ids: number[]) => invoke<AdRange[]>("read_ad_range", { ids }),
  startCalibration: () => invoke<void>("start_calibration"),
  stopCalibration: () => invoke<void>("stop_calibration"),
  /** 监测指定键的行程（空数组 = 让设备用默认集合）；流要成对 `stop`。 */
  startTravelMonitor: (ids: number[] = []) =>
    invoke<void>("start_travel_monitor", { ids }),
  stopTravelMonitor: () => invoke<void>("stop_travel_monitor"),
  /** 每次 UI tick 调一次：重新起流并收集样本（设备不重发就会停流）。 */
  pollTravelMonitor: (ids: number[], timeoutMs: number) =>
    invoke<TriggerEvents>("poll_travel_monitor", { ids, timeoutMs }),
  /** 因消费端落后而被丢弃的报文数（窗口隐藏时 webview 会把定时器节流到 ~1Hz）。 */
  droppedReports: () => invoke<number>("dropped_reports"),
  /** 收集设备在 timeoutMs 内主动上报的行程/校准样本（不发任何命令）。 */
  readTriggerEvents: (timeoutMs: number) =>
    invoke<TriggerEvents>("read_trigger_events", { timeoutMs }),

  // --- 设备级开关（docs/commands.md §1.2）------------------------------------
  deviceSettings: () => invoke<DeviceSettings>("device_settings"),
  settingsCaps: () => invoke<SettingsCaps>("settings_caps"),
  setOsMode: (value: number) => invoke<void>("set_os_mode", { value }),
  setSleepTime: (value: number) => invoke<void>("set_sleep_time", { value }),
  setWinKeyLock: (value: boolean) => invoke<void>("set_win_key_lock", { value }),
  setPollingRate: (value: number) => invoke<void>("set_polling_rate", { value }),
  setComboOptimization: (value: boolean) => invoke<void>("set_combo_optimization", { value }),
  setAdaptiveCalibration: (value: boolean) => invoke<void>("set_adaptive_calibration", { value }),
  setDebounceMode: (value: number) => invoke<void>("set_debounce_mode", { value }),
  setDebounceTime: (value: number) => invoke<void>("set_debounce_time", { value }),
  setLowPowerMode: (value: boolean) => invoke<void>("set_low_power_mode", { value }),
  setWasdSwapped: (value: boolean) => invoke<void>("set_wasd_swapped", { value }),
  setSideLightSync: (value: boolean) => invoke<void>("set_side_light_sync", { value }),
};

export const toHex = (n: number, w = 2): string =>
  n.toString(16).padStart(w, "0").toUpperCase();

// --- 神光同步（docs 见 src-tauri/src/music.rs）--------------------------------

export interface MusicStatus {
  running: boolean;
  frames: number;
  bands: number[];
  peak: number;
  error: string | null;
}
