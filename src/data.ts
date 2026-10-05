import modelsJson from "./data/models.json";
import keyboardMapJson from "./data/keyboard_map.json";
import keycodesJson from "./data/keycodes.json";
import layoutJson from "./data/layout68.json";
import effectsJson from "./data/effects.json";

export interface LayoutKey {
  x: number;
  y: number;
  width: number;
  height: number;
  keyValue: number;
  fnValue: number;
  row: number;
  col: number;
  name: string;
  defaultKeycode: number;
}

export interface KeycodeEntry {
  code: string;
  value: number;
  name: string;
}

export interface KeyboardMapEntry {
  mapKey: number;
  defaultKey: string;
  browserValue: number;
  browserCode: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  type?: number;
}

export const layout68 = layoutJson as unknown as LayoutKey[];
export const keycodes = (keycodesJson as { keycodes: KeycodeEntry[] })
  .keycodes;
export const keyboardMap = (
  keyboardMapJson as { keyboardMap: KeyboardMapEntry[] }
).keyboardMap;
export const models = modelsJson as unknown as {
  uuidModels: { uuid: number; uuidHex: string; customName: string | null }[];
};

/** 灯光效果名称表（effects.json：id ↔ 名称，取自网页驱动源码并经实机核对）。 */
export interface EffectEntry {
  id: number;
  name: string;
  i18nKey?: string;
}

export interface EffectsTable {
  device: string;
  /** 键盘灯效（主灯/Logo/灯箱），按 id 升序。 */
  keyboard: EffectEntry[];
  /** 氛围灯效（侧灯），按 id 升序。 */
  side: EffectEntry[];
  /** 官方 UI 展示顺序（id 列表）。 */
  keyboardUiOrder: number[];
  sideUiOrder: number[];
}

export const effects = effectsJson as unknown as EffectsTable;

/** Physical keys of the 104-key picker map (mapKey == device key id). */
export const physicalKeys = keyboardMap.filter((e) => e.mapKey <= 218);

/** Keycode picker groups, by the page's 7 tab types (keycodes.md sec.4). */
export const pickerGroups = [
  { label: "键盘按键", entries: physicalKeys },
  {
    label: "系统/组合/鼠标/媒体",
    entries: keyboardMap.filter((e) => e.mapKey > 218),
  },
];

/** 固件出厂的 Fn 功能键（键码 type 0x08/0x09，本机实测读出；语义见 docs/keycodes.md §6.1）。
 *  编码：`0x08 <attr> <dir> <target>` / `0x09 00 <profile>`。 */
const FN_ATTR: Record<number, string> = { 0: "灯效", 2: "颜色", 3: "亮度", 4: "速度" };
const FN_DIR: Record<number, string> = { 0: "切换", 1: "+", 2: "−" };
const FN_TARGET: Record<number, string> = { 0: "输入区灯", 1: "侧灯" };

export function keycodeName(kc: number): string {
  const type = (kc >>> 24) & 0xff;
  if (type === 0x0d) return kc === 0x0d000000 ? "Fn" : "Fn1";
  if (type === 0x03) return `宏 #${kc & 0xff}`;
  if (type === 0x10) return "连发键";
  if (type === 0x12) return "文本宏";
  if (type === 0x09) return `切换板载配置 ${(kc & 0xff) + 1}`;
  if (type === 0x08) {
    const attr = (kc >>> 16) & 0xff;
    const dir = (kc >>> 8) & 0xff;
    const target = kc & 0xff;
    return `${FN_TARGET[target] ?? `目标${target}`}${FN_ATTR[attr] ?? `属性${attr}`}${FN_DIR[dir] ?? `动作${dir}`}`;
  }
  if (type === 0x07) return `Fn 功能键 0x${(kc & 0xff).toString(16).padStart(2, "0")}`;
  const hit = keyboardMap.find((e) => e.browserValue === kc);
  if (hit) return hit.defaultKey;
  if (type === 0x01) return "鼠标键";
  if (type === 0x02) return `媒体 0x${(kc & 0xffff).toString(16)}`;
  const mods: Array<[number, string]> = [
    [0x00010000, "Ctrl"],
    [0x00020000, "Shift"],
    [0x00040000, "Alt"],
    [0x00080000, "Win"],
    [0x00100000, "RCtrl"],
    [0x00200000, "RShift"],
    [0x00400000, "RAlt"],
  ];
  const parts = mods.filter(([b]) => (kc & b) !== 0).map(([, n]) => n);
  const hid = (kc & 0x007f0000) !== 0 ? (kc >> 8) & 0xff : kc & 0xff;
  if (hid !== 0) {
    const k = keycodes.find((e) => e.value === hid);
    parts.push(k ? k.name : `0x${hid.toString(16)}`);
  }
  return parts.length ? parts.join("+") : "None";
}
