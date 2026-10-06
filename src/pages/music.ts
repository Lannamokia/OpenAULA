import { api, type ColorChannel, type KeyColor, type MusicStatus, type Rgb } from "../api";
import { beginLoading, el, toast } from "../ui";

/** 频段数范围，与 src-tauri/src/music.rs 的 MIN_BANDS / MAX_BANDS 保持一致。 */
const BAND_MIN = 4;
const BAND_MAX = 24;
/** 状态轮询间隔（频段条与读数），独立于下发的刷新率。 */
const STATUS_MS = 250;
/**
 * **标准通道**在无线链路上一次下发就是一个完整往返（接近 100ms），比这更快的节拍
 * 只是白白丢帧。快通道不等应答，没有这个限制。
 */
const WIRELESS_MIN_MS = 100;

/** null = 还读不到（设备没连上等），按最保守的无线速率处理。 */
type Link = "wired" | "wireless" | null;

/** 用户选择的通道：自动 = 按链路（无线用快通道、有线用标准通道）。 */
type ChannelMode = "auto" | "fast" | "app";

/** `0x84/0x17` 档位码 → 名称（与后端 POLLING_RATES 一致）。 */
const POLL_RATES: Record<number, string> = {
  0: "1KHz", 1: "500Hz", 2: "250Hz", 3: "125Hz", 4: "8KHz", 5: "4KHz", 6: "2KHz",
};

interface Session {
  /** 已成功 music_start。 */
  running: boolean;
  bands: number;
  gain: number;
  fps: number;
  status: MusicStatus | null;
  link: Link;
  /** `0x84/0x17` 回报率档位码（影响可用上行带宽）。 */
  pollRate: number | null;
  /** 本次启动以来成功下发的帧数与丢弃的帧数。 */
  sent: number;
  dropped: number;
  /** 实测下发帧率（每 STATUS_MS 采一次样，滑动平均）。 */
  actualFps: number;
  /** 单帧耗时（取帧 + 下发）的滑动平均，毫秒。 */
  sendMs: number;
  /** 用户选择的通道。 */
  channel: ChannelMode;
  /** 后端回报的、上一帧实际走上的通道（还没发过帧时为 null）。 */
  activeChannel: ColorChannel | null;
  /** 上一帧快通道写失败而退回标准通道的原因。 */
  fallback: string | null;
  /** 快通道上一帧发出的报文条数（标准通道为 0）—— 真机验证时看得见的一手读数。 */
  packets: number;
}

// 后端采集线程是全局的，切页不该把灯效断掉，所以运行状态放在模块级，
// 重进页面时只在新的 DOM 上重新挂定时器。
let session: Session | null = null;
let frameTimer = 0;
let statusTimer = 0;
/** 当前 frameTimer 的间隔，用来判断是否要按新的实测节奏重挂定时器。 */
let frameInterval = 0;
let inFlight = false;
/** 上一次帧率采样的时刻与当时的成功帧数。 */
let rateAt = 0;
let rateSent = 0;

function clearTimers(): void {
  if (frameTimer) window.clearInterval(frameTimer);
  if (statusTimer) window.clearInterval(statusTimer);
  frameTimer = 0;
  statusTimer = 0;
  frameInterval = 0;
}

function linkLabel(link: Link): string {
  return link === "wired" ? "有线" : link === "wireless" ? "8K 无线" : "未知";
}

/** UI 上的通道名（不暴露协议细节）。 */
function channelLabel(c: ColorChannel | null): string {
  return c === "wireless" ? "无线快通道" : c === "app" ? "标准通道" : "—";
}

/**
 * 本帧是否走无线快通道。自动模式按链路选：8K 无线用快通道，有线继续走已验证的
 * 标准通道（快通道在线下未验证）。
 */
function usesFastChannel(s: Session): boolean {
  if (s.channel === "fast") return true;
  if (s.channel === "app") return false;
  return s.link === "wireless";
}

/**
 * 生效的发送间隔。下限由链路定：**标准通道**在无线链路上一次下发就是一个完整往返
 * （至少 WIRELESS_MIN_MS），快通道没有这个限制。上限跟着**实测**的单帧耗时走：
 * 一帧要多久就隔多久再发，这样既不比链路能承受的更快，也不让发送堆在设备那边。
 * 还没测到耗时（sendMs = 0）时只按下限。
 */
function frameIntervalMs(s: Session): number {
  const want = Math.round(1000 / s.fps);
  const floor = s.link === "wired" || usesFastChannel(s) ? want : Math.max(want, WIRELESS_MIN_MS);
  const paced = Math.ceil(s.sendMs * 1.15) + 5;
  return Math.max(floor, paced);
}

function effectiveFps(s: Session): number {
  return Math.round(1000 / frameIntervalMs(s));
}

/** 频段条的色相：与键盘上的柱状频谱同一套（低频偏红 → 高频偏紫）。 */
function bandHue(i: number, n: number): number {
  return n <= 1 ? 200 : 8 + (288 * i) / (n - 1);
}

export async function renderMusic(page: HTMLElement): Promise<void> {
  clearTimers();
  const st: Session = (session ??= {
    running: false,
    bands: 12,
    gain: 1,
    fps: 60,
    status: null,
    link: null,
    pollRate: null,
    sent: 0,
    dropped: 0,
    actualFps: 0,
    sendMs: 0,
    channel: "auto",
    activeChannel: null,
    fallback: null,
    packets: 0,
  });

  const wirelessNote = el("div", { class: "warn-line" });
  wirelessNote.hidden = true;
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
    // 键盘本身是 8K 回报率，帧率上限给到 120；默认 60。（无线另有限速，见读数）
    min: "10",
    max: "120",
    step: "1",
    value: String(st.fps),
  });
  const fpsVal = el("span", { class: "mono", text: `${st.fps} fps` });
  const accentVal = el("span", { class: "mono", text: "—" });
  const accentSwatch = el("span");
  Object.assign(accentSwatch.style, {
    display: "inline-block",
    width: "14px",
    height: "14px",
    borderRadius: "3px",
    border: "1px solid rgba(127,127,127,.45)",
    verticalAlign: "-2px",
    marginRight: "6px",
  });

  const statFrames = el("div", { class: "v", text: "0" });
  const statPeak = el("div", { class: "v", text: "0.00" });
  const statBands = el("div", { class: "v", text: "—" });
  const statState = el("div", { class: "v", text: "未运行" });
  const statLink = el("div", { class: "v", text: "—" });
  const statPoll = el("div", { class: "v", text: "—" });
  const statRate = el("div", { class: "v", text: "—" });
  const statActual = el("div", { class: "v", text: "—" });
  const statDropped = el("div", { class: "v", text: "0" });
  const statChannel = el("div", { class: "v", text: "—" });
  const sendHint = el("span", { class: "hint", text: "单帧耗时 —" });
  const channelHint = el("span", { class: "hint", text: "" });

  const channelSel = el("select", { style: "min-width:150px" });
  for (const [v, label] of [
    ["auto", "自动（按链路）"],
    ["fast", "无线快通道"],
    ["app", "标准通道"],
  ] as [ChannelMode, string][]) {
    const opt = el("option", { value: v, text: label });
    if (v === st.channel) opt.selected = true;
    channelSel.append(opt);
  }
  // 换通道等于换了一条下发路径：旧的单帧耗时和读数都不作数了。
  channelSel.onchange = () => {
    st.channel = channelSel.value as ChannelMode;
    st.sendMs = 0;
    st.activeChannel = null;
    st.fallback = null;
    st.packets = 0;
    if (st.running) startTimers();
    renderControls();
    renderStatus();
  };

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

  /** 链路是无线接收器吗 —— 它决定下面那条告警显不显示。 */
  const wireless = (): boolean => st.link === "wireless";

  function renderControls(): void {
    const off = wireless();
    startBtn.disabled = st.running;
    stopBtn.disabled = !st.running;
    bandIn.disabled = st.running;
    startBtn.textContent = "启动";
    // 无线下逐帧推直控颜色**可能**出现整块键盘的杂色/白色闪烁，根因是 2.4G 链路余量：
    // 净室与"接收器离键盘 15cm 内无遮挡"时基本正常（30cm 约每分钟一次），拉开距离或有干扰才出现，
    // 且与帧率、下发通道都无关。所以给的是"靠近接收器 / 改有线"，而不是调参数。
    // （15cm 是苛刻电磁环境下的值，常规环境可以放远，以不闪为准）
    wirelessNote.hidden = !off;
    if (off) {
      wirelessNote.textContent =
        "无线连接下音乐律动可能出现杂色闪烁，与 2.4G 电磁环境和接收器距离有关：接收器离键盘 15cm 内、无遮挡时基本正常（30cm 时约每分钟仍会闪一次）。该距离是在路由器满功率 + 多个 2.4G 收发器旁的苛刻环境下测的，常规环境可适当放远。";
    }
  }

  function renderStatus(): void {
    const s = st.status;
    statFrames.textContent = String(s?.frames ?? 0);
    statPeak.textContent = (s?.peak ?? 0).toFixed(2);
    statState.textContent = st.running ? (s?.running ? "采集中" : "启动中…") : "已停止";
    const eff = effectiveFps(st);
    statLink.textContent = linkLabel(st.link);
    statPoll.textContent = POLL_RATES[st.pollRate ?? -1] ?? "—";
    statRate.textContent = `${eff} fps${eff < st.fps ? "（已限速）" : ""}`;
    fpsVal.textContent = eff < st.fps ? `${st.fps} → ${eff} fps` : `${st.fps} fps`;
    statActual.textContent = st.running ? `${st.actualFps.toFixed(1)} fps` : "—";
    statDropped.textContent = String(st.dropped);
    // 读数说的是**实际**走过的通道：还没发过帧就显示接下来会走哪条。
    statChannel.textContent = channelLabel(
      st.activeChannel ?? (usesFastChannel(st) ? "wireless" : "app"),
    );
    statChannel.style.color = st.fallback ? "#e5484d" : "";
    channelHint.textContent = st.fallback
      ? `无线快通道写不出去，已自动改用标准通道：${st.fallback}`
      : "";
    sendHint.textContent =
      (st.sendMs > 0 ? `单帧耗时 ${st.sendMs.toFixed(0)} ms` : "单帧耗时 —") +
      (st.packets > 0 ? ` · 分包 ${st.packets}` : "");

    const bands = s?.bands ?? [];
    statBands.textContent = bands.length ? `${bands.length} 段` : "—";
    bars.replaceChildren();
    if (!bands.length) {
      bars.append(
        el("span", { class: "hint", text: st.running ? "等待音频数据…" : "未运行" }),
      );
      return;
    }
    // 预览用的柱高与亮度都乘增益，跟键盘上真正推出去的那一帧对得上。
    for (const [i, v] of bands.entries()) {
      const t = Math.max(0, Math.min(1, v * st.gain));
      const b = el("div");
      b.style.flex = "1";
      b.style.height = `${Math.max(2, Math.round(t * 100))}%`;
      b.style.background = `hsl(${bandHue(i, bands.length).toFixed(0)} 95% ${(16 + 46 * t).toFixed(0)}%)`;
      b.style.borderRadius = "2px";
      bars.append(b);
    }
  }

  /** 实测帧率：窗口内的成功帧数；窗口内没发出去就衰减到 0。 */
  function sampleRate(): void {
    const now = performance.now();
    if (rateAt === 0) {
      rateAt = now;
      rateSent = st.sent;
      return;
    }
    const dt = now - rateAt;
    if (dt < STATUS_MS / 2) return;
    const inst = ((st.sent - rateSent) * 1000) / dt;
    st.actualFps = st.actualFps * 0.5 + inst * 0.5;
    rateAt = now;
    rateSent = st.sent;
  }

  /**
   * 下发一帧，返回**真正**用上的通道。走快通道时后端在写报文失败后已经自己退回
   * 标准通道并把原因带回来，这里只负责把它记下来给读数用。
   */
  async function sendFrame(frame: KeyColor[]): Promise<ColorChannel> {
    if (!usesFastChannel(st)) {
      await api.setKeyColors(frame);
      st.fallback = null;
      st.packets = 0;
      return "app";
    }
    const r = await api.setKeyColorsWireless(frame);
    st.fallback = r.fallback;
    st.packets = r.packets;
    return r.channel;
  }

  async function tickFrame(): Promise<void> {
    // 绝不排队：上一帧还在路上就丢掉这一帧，只记数。
    if (inFlight) {
      st.dropped++;
      return;
    }
    inFlight = true;
    const t0 = performance.now();
    try {
      const frame = await api.musicFrame(st.gain);
      const channel = await sendFrame(frame);
      const dt = performance.now() - t0;
      if (channel !== st.activeChannel) {
        // 换了通道：旧的单帧耗时是另一条路径的，留着会把新通道也拖慢。
        st.activeChannel = channel;
        st.sendMs = dt;
      } else {
        st.sendMs = st.sendMs > 0 ? st.sendMs * 0.6 + dt * 0.4 : dt;
      }
      st.sent++;
    } catch (e) {
      // 出错就停：不重试、不刷屏。
      abort(`灯效下发失败，已停止：${e}`);
    } finally {
      inFlight = false;
    }
  }

  async function tickStatus(): Promise<void> {
    try {
      const s = await api.musicStatus();
      st.status = s;
      sampleRate();
      if (s.error) {
        abort(`音频采集出错，已停止：${s.error}`);
        return;
      }
      if (!s.running) {
        abort(null);
        return;
      }
      // 实测的单帧耗时变了（链路变慢等）就按新的节奏重挂定时器。
      if (frameTimer && frameIntervalMs(st) !== frameInterval) startTimers();
      renderStatus();
    } catch (e) {
      abort(`状态读取失败，已停止：${e}`);
    }
  }

  function startTimers(): void {
    clearTimers();
    frameInterval = frameIntervalMs(st);
    frameTimer = window.setInterval(() => void tickFrame(), frameInterval);
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

  /**
   * 读一次链路（有线 / 无线），它决定下发的速率上限。整个设备信息是一串命令，
   * 无线下要好几百毫秒，所以只在进页面和起流时各读一次。
   */
  async function refreshLink(): Promise<void> {
    try {
      const d = await api.deviceStatus();
      st.link = d.framed ? "wireless" : "wired";
      try {
        st.pollRate = (await api.deviceSettings()).polling_rate;
      } catch {
        st.pollRate = null;
      }
    } catch {
      // 读不到就保持上一次的结果；为 null 时按最保守的无线速率跑。
    }
    renderStatus();
    renderControls();
    // 链路变了，生效速率跟着变，定时器要重挂。
    if (st.running) startTimers();
  }

  async function startStream(): Promise<void> {
    showError(null);
    startBtn.disabled = true;
    const task = beginLoading("正在启动神光同步…");
    try {
      await refreshLink();
      // 无线下推逐键颜色**可能**出现整块杂色/白闪，根因是 2.4G 链路余量（净室完全正常，家用 15cm 内基本正常）。
      // 拦一道说明触发条件与应对，用户坚持要用也放行。（15cm 是苛刻电磁环境下的值）
      const wirelessWarn =
        "无线连接下音乐律动可能出现随机周期的杂色闪烁，与 2.4G 电磁环境和接收器距离有关。\n\n" +
        "接收器离键盘 15cm 内、无遮挡时基本正常；30cm 时约每分钟仍会闪一次。该距离来自苛刻的电磁环境（路由器满功率 + 多个 2.4G 收发器旁），常规环境下可以适当放远。闪烁明显时请改用有线连接。\n\n" +
        "仍要启动吗？";
      if (wireless() && !window.confirm(wirelessWarn)) {
        st.running = false;
        renderControls();
        renderStatus();
        return;
      }
      await api.musicStart(Math.round(st.bands));
    } catch (e) {
      showError(`启动音频采集失败：${e}`);
      toast(`启动失败：${e}`, true);
      st.running = false;
      renderControls();
      renderStatus();
      return;
    } finally {
      task.done();
    }
    st.running = true;
    st.sent = 0;
    st.dropped = 0;
    st.actualFps = 0;
    st.sendMs = 0;
    st.activeChannel = null;
    st.fallback = null;
    st.packets = 0;
    rateAt = 0;
    rateSent = 0;
    renderControls();
    renderStatus();
    startTimers();
  }

  async function stopStream(): Promise<void> {
    clearTimers();
    st.running = false;
    const task = beginLoading("正在停止神光同步…");
    try {
      await api.musicStop();
      toast("已停止神光同步");
    } catch (e) {
      showError(`停止失败：${e}`);
    } finally {
      task.done();
    }
    st.status = null;
    st.actualFps = 0;
    renderControls();
    renderStatus();
  }

  function paintAccent(c: Rgb): void {
    const rgb = `rgb(${c.r}, ${c.g}, ${c.b})`;
    accentVal.textContent = rgb;
    accentVal.style.color = rgb;
    accentSwatch.style.background = rgb;
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
    // 拖动时就把生效速率换上去，免得读数显示的节奏跟实际发的不一致。
    if (st.running) startTimers();
    renderStatus();
  };

  // 只要主题色写进主灯 / 侧灯，频谱推送照跑，两者互不干扰。
  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    const task = beginLoading("正在把主题色写进主灯与侧灯…");
    try {
      const r = await api.applyAccentToZones();
      paintAccent(r.color);
      const failed = r.zones.filter((z) => !z.ok);
      if (failed.length) {
        const detail = failed.map((z) => `${z.name}：${z.error ?? "写入失败"}`).join("；");
        showError(`主题色没有完全写进去 —— ${detail}`);
        toast("部分灯区写入失败，详情见页面提示", true);
      } else {
        showError(null);
        toast("已把 Windows 主题色写入主灯与侧灯");
      }
    } catch (e) {
      showError(`主题色写入失败：${e}`);
      toast(`主题色写入失败：${e}`, true);
    } finally {
      task.done();
      syncBtn.disabled = false;
    }
  };

  page.replaceChildren(
    el("h1", { text: "神光同步" }),
    el("p", {
      class: "sub",
      text: "让键盘灯光跟随电脑正在播放的声音律动：每一列键是一根频谱柱，从下往上长。",
    }),
    el(
      "div",
      { class: "card" },
      el("h2", { text: "控制" }, el("span", { class: "hint", text: "随系统声音变化" })),
      el("div", { class: "row" }, startBtn, stopBtn),
      wirelessNote,
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
        field("下发通道", channelSel),
      ),
      el("div", {
        class: "hint",
        text: "自动：无线链路走无线快通道（不等应答，能跑满帧率），有线走标准通道。快通道更快，但个别固件可能不认 —— 灯完全不亮或卡住就切回标准通道。",
      }),
      el("div", { class: "block-label", text: "Windows 主题色" }),
      el(
        "div",
        { class: "row" },
        syncBtn,
        el("span", { class: "hint" }, accentSwatch, "当前强调色：", accentVal),
      ),
      el("div", {
        class: "hint",
        text: "点按后写入键盘主灯与侧灯的自定义颜色，其余灯效参数保持不变。",
      }),
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
      el("div", { class: "block-label", text: "下发" }),
      el(
        "div",
        { class: "row" },
        stat("链路", statLink),
        stat("回报率", statPoll),
        stat("下发通道", statChannel),
        stat("生效帧率", statRate),
        stat("实际帧率", statActual),
        stat("丢弃帧数", statDropped),
      ),
      el("div", { class: "row", style: "margin-top:8px" }, sendHint, channelHint),
      errBox,
      el("div", { class: "block-label", text: "实时频段" }),
      bars,
    ),
  );

  renderControls();
  renderStatus();
  void loadAccent();
  void refreshLink();
  if (st.running) {
    // 从别的页面切回来：后端还在采集，重新挂上定时器即可。
    void tickStatus();
    startTimers();
  }

  /** 进页面就把当前强调色读出来填色块（失败不报错，点按钮时还会再试）。 */
  async function loadAccent(): Promise<void> {
    try {
      paintAccent(await api.windowsAccentColor());
    } catch {
      /* 读不到注册表就留空 */
    }
  }
}
