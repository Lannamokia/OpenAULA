import { api, type MusicStatus } from "../api";
import { el, toast } from "../ui";

/** 频段数范围，与 src-tauri/src/music.rs 的 MIN_BANDS / MAX_BANDS 保持一致。 */
const BAND_MIN = 4;
const BAND_MAX = 24;
/** 状态轮询间隔（频段条与读数），独立于下发的刷新率。 */
const STATUS_MS = 250;

interface Session {
  /** 已成功 music_start。 */
  running: boolean;
  bands: number;
  gain: number;
  fps: number;
  status: MusicStatus | null;
}

// 后端采集线程是全局的，切页不该把灯效断掉，所以运行状态放在模块级，
// 重进页面时只在新的 DOM 上重新挂定时器。
let session: Session | null = null;
let frameTimer = 0;
let statusTimer = 0;
let inFlight = false;

function clearTimers(): void {
  if (frameTimer) window.clearInterval(frameTimer);
  if (statusTimer) window.clearInterval(statusTimer);
  frameTimer = 0;
  statusTimer = 0;
}

/** 与 Rust 侧一致的能量→色相映射（低=暗蓝、中=青绿、高=红）。 */
function barColor(v: number): string {
  const t = Math.max(0, Math.min(1, v));
  const hue = t < 0.5 ? 240 + (165 - 240) * (t * 2) : 165 - 165 * ((t - 0.5) * 2);
  return `hsl(${hue.toFixed(0)} 100% ${(12 + 48 * t).toFixed(0)}%)`;
}

export async function renderMusic(page: HTMLElement): Promise<void> {
  clearTimers();
  const st: Session = (session ??= {
    running: false,
    bands: 12,
    gain: 1,
    fps: 60,
    status: null,
  });

  const startBtn = el("button", { class: "btn primary", text: "启动" });
  const stopBtn = el("button", { class: "btn danger", text: "停止" });
  const syncBtn = el("button", { class: "btn", text: "同步 Windows 主题色" });

  const bandIn = el("input", {
    type: "range",
    min: String(BAND_MIN),
    max: String(BAND_MAX),
    step: "1",
    value: String(st.bands),
  });
  const bandVal = el("span", { class: "mono", text: `${st.bands} 段` });
  const gainIn = el("input", {
    type: "range",
    min: "0.5",
    max: "5",
    step: "0.1",
    value: String(st.gain),
  });
  const gainVal = el("span", { class: "mono", text: `${st.gain.toFixed(1)}×` });
  const fpsIn = el("input", {
    type: "range",
    // 键盘本身是 8K 回报率，帧率上限给到 120；默认 60。
    min: "10",
    max: "120",
    step: "1",
    value: String(st.fps),
  });
  const fpsVal = el("span", { class: "mono", text: `${st.fps} fps` });
  const accentVal = el("span", { class: "mono", text: "—" });

  const statFrames = el("div", { class: "v", text: "0" });
  const statPeak = el("div", { class: "v", text: "0.00" });
  const statBands = el("div", { class: "v", text: "—" });
  const statState = el("div", { class: "v", text: "未运行" });

  const errBox = el("div", { class: "empty", text: "" });
  errBox.style.display = "none";
  errBox.style.color = "#e5484d";

  const bars = el("div");
  bars.style.display = "flex";
  bars.style.alignItems = "flex-end";
  bars.style.gap = "3px";
  bars.style.height = "104px";
  bars.style.padding = "8px 10px";
  bars.style.background = "rgba(127,127,127,.12)";
  bars.style.borderRadius = "8px";

  const stat = (k: string, v: HTMLElement) =>
    el("div", { class: "stat" }, el("div", { class: "k", text: k }), v);
  const field = (label: string, input: HTMLElement) =>
    el("label", { class: "field" }, label, input);

  function showError(msg: string | null): void {
    errBox.textContent = msg ?? "";
    errBox.style.display = msg ? "" : "none";
  }

  function renderControls(): void {
    startBtn.disabled = st.running;
    stopBtn.disabled = !st.running;
    // 频段数改了要重建 FFT 分析器，运行时先禁止改动。
    bandIn.disabled = st.running;
  }

  function renderStatus(): void {
    const s = st.status;
    statFrames.textContent = String(s?.frames ?? 0);
    statPeak.textContent = (s?.peak ?? 0).toFixed(2);
    statState.textContent = st.running ? (s?.running ? "采集中" : "启动中…") : "已停止";
    const bands = s?.bands ?? [];
    statBands.textContent = bands.length ? `${bands.length} 段` : "—";
    bars.replaceChildren();
    if (!bands.length) {
      bars.append(
        el("span", { class: "hint", text: st.running ? "等待音频数据…" : "未运行" }),
      );
      return;
    }
    for (const v of bands) {
      const b = el("div");
      b.style.flex = "1";
      b.style.height = `${Math.max(2, Math.round(v * 100))}%`;
      b.style.background = barColor(v);
      b.style.borderRadius = "2px";
      bars.append(b);
    }
  }

  async function tickFrame(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const frame = await api.musicFrame(st.gain);
      await api.setKeyColors(frame);
    } catch (e) {
      abort(`灯效下发失败，已停止：${e}`);
    } finally {
      inFlight = false;
    }
  }

  async function tickStatus(): Promise<void> {
    try {
      const s = await api.musicStatus();
      st.status = s;
      if (s.error) {
        abort(`音频采集出错，已停止：${s.error}`);
        return;
      }
      if (!s.running) {
        abort(null);
        return;
      }
      renderStatus();
    } catch (e) {
      abort(`状态读取失败，已停止：${e}`);
    }
  }

  function startTimers(): void {
    clearTimers();
    frameTimer = window.setInterval(() => void tickFrame(), Math.round(1000 / st.fps));
    statusTimer = window.setInterval(() => void tickStatus(), STATUS_MS);
  }

  /** 出错或设备侧已停：停定时器并提示，不让报错刷屏。 */
  function abort(msg: string | null): void {
    clearTimers();
    if (st.running) {
      st.running = false;
      void api.musicStop().catch(() => undefined);
    }
    if (msg) {
      showError(msg);
      toast(msg, true);
    }
    renderControls();
    renderStatus();
  }

  async function startStream(): Promise<void> {
    showError(null);
    startBtn.disabled = true;
    try {
      await api.musicStart(Math.round(st.bands));
    } catch (e) {
      showError(`启动音频采集失败：${e}`);
      toast(`启动失败：${e}`, true);
      st.running = false;
      renderControls();
      renderStatus();
      return;
    }
    st.running = true;
    renderControls();
    renderStatus();
    startTimers();
  }

  async function stopStream(): Promise<void> {
    clearTimers();
    st.running = false;
    try {
      await api.musicStop();
      toast("已停止神光同步");
    } catch (e) {
      showError(`停止失败：${e}`);
    }
    st.status = null;
    renderControls();
    renderStatus();
  }

  startBtn.onclick = () => void startStream();
  stopBtn.onclick = () => void stopStream();

  bandIn.oninput = () => {
    st.bands = Number(bandIn.value);
    bandVal.textContent = `${st.bands} 段`;
  };
  // 频段数变了要重建 FFT 分析器：music_start 会自己重启采集线程。
  bandIn.onchange = () => {
    if (st.running) void startStream();
  };
  gainIn.oninput = () => {
    st.gain = Number(gainIn.value);
    gainVal.textContent = `${st.gain.toFixed(1)}×`;
  };
  fpsIn.oninput = () => {
    st.fps = Number(fpsIn.value);
    fpsVal.textContent = `${st.fps} fps`;
  };
  fpsIn.onchange = () => {
    if (st.running) startTimers();
  };

  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    // 两者走同一条逐键改色通道，会互相覆盖，先把频谱推送停掉。
    if (st.running) await stopStream();
    try {
      const c = await api.windowsAccentColor();
      accentVal.textContent = `rgb(${c.r}, ${c.g}, ${c.b})`;
      accentVal.style.color = `rgb(${c.r}, ${c.g}, ${c.b})`;
      const frame = await api.musicAccentFrame();
      await api.setKeyColors(frame);
      toast(`已按主题色 rgb(${c.r}, ${c.g}, ${c.b}) 下发全键盘`);
    } catch (e) {
      showError(`主题色同步失败：${e}`);
      toast(`主题色同步失败：${e}`, true);
    } finally {
      syncBtn.disabled = false;
    }
  };

  page.replaceChildren(
    el("h1", { text: "神光同步" }),
    el("p", {
      class: "sub",
      text: "让键盘灯光跟随电脑正在播放的声音律动。",
    }),
    el(
      "div",
      { class: "card" },
      el("h2", { text: "控制" }, el("span", { class: "hint", text: "随系统声音变化" })),
      el("div", { class: "row" }, startBtn, stopBtn),
      el(
        "div",
        { class: "row", style: "margin-top:10px" },
        field("频段数", el("div", { class: "slider-row" }, bandIn, bandVal)),
        field("增益", el("div", { class: "slider-row" }, gainIn, gainVal)),
      ),
      el(
        "div",
        { class: "row" },
        field("更新频率", el("div", { class: "slider-row" }, fpsIn, fpsVal)),
        el("span", { class: "hint", text: "改动立即生效。" }),
      ),
      el("div", { class: "block-label", text: "Windows 主题色" }),
      el(
        "div",
        { class: "row" },
        syncBtn,
        el("span", { class: "hint" }, "当前强调色：", accentVal),
      ),
    ),
    el(
      "div",
      { class: "card" },
      el(
        "h2",
        { text: "状态" },
        el("span", { class: "hint", text: "实时读数" }),
      ),
      el(
        "div",
        { class: "row" },
        stat("已处理帧", statFrames),
        stat("峰值能量", statPeak),
        stat("频段", statBands),
        stat("状态", statState),
      ),
      errBox,
      el("div", { class: "block-label", text: "实时频段" }),
      bars,
    ),
  );

  renderControls();
  renderStatus();
  if (st.running) {
    // 从别的页面切回来：后端还在采集，重新挂上定时器即可。
    void tickStatus();
    startTimers();
  }
}
