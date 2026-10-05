import { api, toHex, DEBOUNCE_MODES, POLLING_RATES } from "../api";
import type { DeviceSettings, SettingsCaps } from "../api";
import { el, toast } from "../ui";

const TOP_NOTE = "调整键盘的整机开关设置。";
const DESC_STYLE = "font-size:12px;color:var(--text-dim);margin-top:2px;line-height:1.5";
const ROW_STYLE = "display:flex;justify-content:space-between;align-items:center;gap:16px;padding:11px 0";
const TITLE_STYLE = "font-size:13.5px;font-weight:600";

export async function renderSettings(page: HTMLElement): Promise<void> {
  const state: { st: DeviceSettings | null; caps: SettingsCaps | null } = { st: null, caps: null };
  let busy = false;

  function setBusy(b: boolean): void {
    busy = b;
    page.querySelectorAll<HTMLElement>("input,select,button").forEach((c) => {
      (c as HTMLInputElement).disabled = b;
    });
  }

  function item(title: string, desc: string, control: HTMLElement): HTMLElement {
    return el(
      "div",
      { style: ROW_STYLE },
      el("div", {}, el("div", { style: TITLE_STYLE }, title), el("div", { style: DESC_STYLE }, desc)),
      control,
    );
  }

  function toggle(checked: boolean, disabled: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const chk = el("input", { type: "checkbox", style: "width:18px;height:18px;accent-color:var(--accent)" });
    chk.checked = checked;
    chk.disabled = disabled;
    chk.onchange = () => onChange(chk.checked);
    return chk;
  }

  function selectCtrl(
    options: { value: number; label: string }[],
    current: number,
    onPick: (v: number) => void,
  ): HTMLSelectElement {
    const sel = el("select", { style: "min-width:150px" });
    for (const o of options) {
      const opt = el("option", { value: String(o.value), text: o.label });
      if (o.value === current) opt.selected = true;
      sel.append(opt);
    }
    sel.onchange = () => onPick(Number(sel.value));
    return sel;
  }

  function numberCtrl(value: number, attrs: Record<string, string>, onCommit: (v: number) => void): HTMLInputElement {
    const inp = el("input", { type: "number", value: String(value), style: "width:110px", ...attrs });
    inp.onchange = () => {
      if (inp.value === "") return;
      const v = Number(inp.value);
      if (!Number.isFinite(v)) {
        inp.value = String(value);
        return;
      }
      onCommit(v);
    };
    return inp;
  }

  function build(): void {
    const { st, caps } = state;
    if (!st || !caps) return;

    const onoff = (v: boolean) => (v ? "已开启" : "已关闭");

    const sysRows = [
      item(
        "Mac 模式",
        "切换到适配 macOS 的键位布局。",
        toggle(st.os_mode === 1, false, (v) => {
          void apply(() => api.setOsMode(v ? 1 : 0), v ? "已切换到 Mac 模式" : "已切换到 Windows 模式");
        }),
      ),
      item(
        "Win 键锁定",
        "开启后 Win 键将被锁定无法使用。",
        toggle(st.win_key_lock, false, (v) => {
          void apply(() => api.setWinKeyLock(v), `Win 键锁定${onoff(v)}`);
        }),
      ),
      item(
        "回报率设置",
        "回报率越高，按键响应越灵敏。",
        selectCtrl(POLLING_RATES, st.polling_rate, (v) => {
          const label = POLLING_RATES.find((o) => o.value === v)?.label ?? String(v);
          void apply(() => api.setPollingRate(v), `回报率已设为 ${label}`);
        }),
      ),
      item(
        "休眠设置",
        "键盘无操作后进入休眠的时间；0 = 不休眠，单位毫秒。",
        numberCtrl(st.sleep_time, { min: "0", max: "65535", step: "100" }, (v) => {
          let n = Math.round(v);
          let clamped = false;
          if (n < 0) {
            n = 0;
            clamped = true;
          }
          // set_sleep_time 按 BE16 下发，超出 65535 固件行为未定义，必须截断。
          if (n > 65535) {
            n = 65535;
            clamped = true;
          }
          void apply(
            () => api.setSleepTime(n),
            clamped ? "输入超出上限，已按 65535 ms 下发" : "休眠时间已更新",
          );
        }),
      ),
    ];

    const keyRows = [
      item(
        "自适应校准",
        "自动微调按键触发，适应环境变化。",
        toggle(st.adaptive_calibration, false, (v) => {
          void apply(() => api.setAdaptiveCalibration(v), `自适应校准${onoff(v)}`);
        }),
      ),
      item(
        "连击优化",
        "减少快速连按时的误触发。",
        toggle(st.combo_optimization, false, (v) => {
          void apply(() => api.setComboOptimization(v), `连击优化${onoff(v)}`);
        }),
      ),
      item(
        "消抖模式",
        "消抖：过滤按键抖动，过大将影响连击手感。",
        selectCtrl(DEBOUNCE_MODES, st.debounce_mode, (v) => {
          const label = DEBOUNCE_MODES.find((o) => o.value === v)?.label ?? String(v);
          void apply(() => api.setDebounceMode(v), `消抖模式已设为 ${label}`);
        }),
      ),
      item(
        "消抖时间",
        "按键触发后的消抖时长，单位毫秒。",
        numberCtrl(st.debounce_time, { min: "0", step: "1" }, (v) => {
          const n = Math.max(0, Math.round(v));
          void apply(() => api.setDebounceTime(n), "消抖时间已更新");
        }),
      ),
      item(
        "WASD ↔ 方向键互换",
        "把 WASD 与方向键对调。",
        toggle(st.wasd_swapped, false, (v) => {
          void apply(() => api.setWasdSwapped(v), v ? "WASD 与方向键已互换" : "已恢复默认键位");
        }),
      ),
    ];

    const lightRows = [
      item(
        "低功耗模式",
        caps.low_power_supported
          ? "灯光关闭时生效。"
          : "灯光关闭时生效。（当前设备不支持低功耗模式）",
        toggle(st.low_power_mode, !caps.low_power_supported, (v) => {
          void apply(() => api.setLowPowerMode(v), `低功耗模式${onoff(v)}`);
        }),
      ),
      item(
        "侧灯同步",
        "侧灯（氛围灯）跟随主灯灯效同步。",
        toggle(st.side_light_sync, false, (v) => {
          void apply(() => api.setSideLightSync(v), `侧灯同步${onoff(v)}`);
        }),
      ),
    ];

    const refreshBtn = el("button", { class: "btn", text: "刷新" });
    refreshBtn.onclick = () => void renderSettings(page);

    const rawHex = st.sleep_info_raw.length ? st.sleep_info_raw.map((b) => toHex(b)).join(" ") : "—";
    const rawCard = el(
      "div",
      { class: "card", style: "opacity:.85" },
      el("h2", { text: "原始上报" }),
      el("div", { class: "mono", style: "font-size:13px;letter-spacing:.08em", text: rawHex }),
      el("p", { class: "sub", style: "margin:10px 0 0", text: "休眠相关原始上报，仅供调试参考。" }),
    );

    page.replaceChildren(
      el("h1", { text: "系统设置" }),
      el("p", { class: "sub", text: TOP_NOTE }),
      el("div", { class: "row", style: "margin:-6px 0 12px" }, refreshBtn),
      card("系统", sysRows),
      card("按键与响应", keyRows),
      card("灯光与功耗", lightRows),
      rawCard,
    );
  }

  function card(title: string, rows: HTMLElement[]): HTMLElement {
    rows.forEach((r, i) => {
      if (i < rows.length - 1) r.style.borderBottom = "1px solid var(--border)";
    });
    return el("div", { class: "card" }, el("h2", { text: title }), ...rows);
  }

  async function refresh(): Promise<void> {
    const [st, caps] = await Promise.all([api.deviceSettings(), api.settingsCaps()]);
    state.st = st;
    state.caps = caps;
    build();
  }

  async function apply(write: () => Promise<void>, okMsg: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await write();
      try {
        await refresh();
        toast(okMsg);
      } catch (e) {
        toast(`已写入，但读回校验失败：${e}`, true);
      }
    } catch (e) {
      alert(`设置失败：${e}`);
      try {
        await refresh();
      } catch {
        // 读回也失败时保留当前界面状态。
      }
    } finally {
      setBusy(false);
    }
  }

  page.replaceChildren(
    el("h1", { text: "系统设置" }),
    el("p", { class: "sub", text: TOP_NOTE }),
    el("div", { class: "card" }, el("h2", { text: "整机开关" }), el("div", { class: "empty", text: "读取中…" })),
  );
  try {
    await refresh();
  } catch (e) {
    const retry = el("button", { class: "btn", text: "重试" });
    retry.onclick = () => void renderSettings(page);
    page.replaceChildren(
      el("h1", { text: "系统设置" }),
      el("p", { class: "sub", text: TOP_NOTE }),
      el(
        "div",
        { class: "card" },
        el("h2", { text: "整机开关" }),
        el("div", { class: "empty", text: `读取失败：${e}` }),
        el("div", { class: "row", style: "justify-content:center;margin-top:4px" }, retry),
      ),
    );
  }
}
