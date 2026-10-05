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
};

export const toHex = (n: number, w = 2): string =>
  n.toString(16).padStart(w, "0").toUpperCase();
