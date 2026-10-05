import {
  api,
  type AdRange,
  type RapidTrigger,
  type SafeArea,
  type SwitchType,
  type TriggerCaps,
} from "../api";
import { layout68 } from "../data";
import axesJson from "../data/axes.json";
import { beginLoading, el, toast } from "../ui";

const SCALE = 1.12;

const LAYERS = [
  { label: "基础层", layer: 0 },
  { label: "Fn 层", layer: 1 },
  { label: "Fn1 层", layer: 2 },
];

const SYSTEMS = [
  { label: "Windows", system: 0 },
  { label: "macOS", system: 1 },
];

/** 官方页面滑杆 props：行程/灵敏度 max = 选中键轴体的 maxTravel（回落 3.4），min 0.1；死区 0..0.5mm。 */
const DEFAULT_TRAVEL_MM = 3.4;
const MIN_TRAVEL_MM = 0.1;
const MAX_DEAD_ZONE_MM = 0.5;

/** 每轮取包的窗口：0 = 非阻塞，取走读线程已经排队的全部报文。 */
const TRAVEL_WINDOW_MS = 0;
/**
 * `0x98/0x01` **不是流，是一次快照**：每发一次 Start，设备只回一条含所有被监测键的报文，
 * 然后彻底安静（实测：不重发就只有最初那 3 条，之后 3 秒一条都没有）。
 * 所以"重发"就是采样本身，刷新率 = 重发频率 —— 早期设成 500ms 就是那 500ms 的延迟来源。
 * 设备实测能吃 1000 次/秒（3 键约 3000 条/秒、0 空档），这里每一轮 UI tick 都重发。
 */
const MON_REARM_MS = 0;
const CAL_REPLAY_MS = 800;
/** 同 TRAVEL_WINDOW_MS：0 = 非阻塞取队列。 */
const CAL_WINDOW_MS = 0;
/** 行程样本超过这么久没再上报就从列表里去掉（键位不活跃）。 */
const LIVE_STALE_MS = 800;

interface AxisEntry {
  label: string;
  id: number;
  maxTravel: number;
  iconColor: string;
}

const AXES = (axesJson as unknown as { axes: AxisEntry[] }).axes;
const AXIS_LABEL = new Map(AXES.map((a) => [a.id, a.label]));

const keyName = (id: number): string =>
  layout68.find((k) => k.keyValue === id)?.name ?? `键 ${id}`;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

const decimalsOf = (v: number): number => {
  const s = v.toFixed(6).replace(/0+$/, "");
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
};

// 设备的监测流（0x98）与校准（0x94）必须成对停掉；定时器放模块级，
// 这样重进页面时能先清掉上一次渲染留下的轮询。
let testTimer = 0;
let calPollTimer = 0;
let calReplayTimer = 0;

// 取包全速、绘制每显示帧一次：取包循环只写内存 map 并登记绘制，不碰 DOM；
// rAF 回调率就是屏幕刷新率（60/120/144Hz 自适应），同一函数一帧内只画一次。
const paintQueue = new Set<() => void>();
let paintRaf = 0;

function schedulePaint(paint: () => void): void {
  paintQueue.add(paint);
  if (paintRaf) return;
  paintRaf = requestAnimationFrame((now) => {
    paintRaf = 0;
    const batch = [...paintQueue];
    paintQueue.clear();
    for (const fn of batch) fn();
    tickFps(now);
  });
}

function cancelPaint(paint: () => void): void {
  paintQueue.delete(paint);
  if (paintQueue.size === 0 && paintRaf) {
    cancelAnimationFrame(paintRaf);
    paintRaf = 0;
  }
}

function cancelAllPaints(): void {
  if (paintRaf) cancelAnimationFrame(paintRaf);
  paintRaf = 0;
  paintQueue.clear();
}

// 绘制帧率读数：最近 FPS_WINDOW 次 rAF 回调间隔的滑动平均；只有文本变了才写 DOM。
const FPS_WINDOW = 30;
const FPS_IDLE = "帧率 —";
let testFpsOut: HTMLElement | null = null;
/** 丢包计数读数（只在测试中显示）。 */
let testDropOut: HTMLElement | null = null;
let dropTimer = 0;
let calFpsOut: HTMLElement | null = null;
let fpsText = FPS_IDLE;
let fpsPrev = 0;
let fpsDeltas: number[] = [];

function setFpsText(text: string): void {
  if (text === fpsText) return;
  fpsText = text;
  if (testFpsOut) testFpsOut.textContent = text;
  if (calFpsOut) calFpsOut.textContent = text;
}

function tickFps(now: number): void {
  if (fpsPrev > 0) fpsDeltas.push(now - fpsPrev);
  fpsPrev = now;
  if (fpsDeltas.length > FPS_WINDOW) fpsDeltas.shift();
  if (fpsDeltas.length < 2) return;
  let sum = 0;
  for (const d of fpsDeltas) sum += d;
  setFpsText(`帧率 ${((fpsDeltas.length * 1000) / sum).toFixed(1)} fps`);
}

function resetFps(): void {
  fpsPrev = 0;
  fpsDeltas = [];
  setFpsText(FPS_IDLE);
}

/** 校准键盘上每个键的实时数值/染色；sig 是上次画过的内容签名，用于跳过没变化的键。 */
interface CalKeyRec {
  key: HTMLElement;
  cap: HTMLElement;
  val: HTMLElement;
  sig: string;
}

interface Slider {
  field: HTMLElement;
  input: HTMLInputElement;
  out: HTMLElement;
  sync: () => void;
}

export async function renderTrigger(page: HTMLElement): Promise<void> {
  window.clearInterval(testTimer);
  window.clearInterval(calPollTimer);
  window.clearInterval(calReplayTimer);
  testTimer = 0;
  calPollTimer = 0;
  calReplayTimer = 0;
  cancelAllPaints();
  testFpsOut = null;
  calFpsOut = null;
  resetFps();
  try {
    await api.stopTravelMonitor();
  } catch {
    /* 设备未连接或本就没在监测，都算正常 */
  }
  try {
    await api.stopCalibration();
  } catch {
    /* 同上 */
  }

  page.replaceChildren(
    el("h1", { text: "触发设置" }),
    el("p", {
      class: "sub",
      text: "调整键程、灵敏度与死区，校准轴体，并实时查看按键行程。",
    }),
  );

  let layer = 0;
  let system = 0;
  let caps: TriggerCaps | null = null;
  let capsErr: string | null = null;

  const selected = new Set<number>();
  let switchTypes = new Map<number, number>();
  let travels = new Map<number, number>();
  let rts = new Map<number, RapidTrigger>();
  let safes = new Map<number, SafeArea>();
  /** 选中集变更的竞态令牌：只有最后一次读取能写界面。 */
  let selToken = 0;

  let testOn = false;
  let testBusy = false;
  let testErr = false;
  let lastArmAt = 0;
  let testBarBox: HTMLElement | null = null;
  let testBarSig = "";
  const live = new Map<number, { mm: number; press: boolean; at: number }>();
  // sig = 上次画过的内容签名（宽度 + 文字），一样就跳过，不动 DOM。
  const testBars = new Map<
    number,
    { fill: HTMLElement; val: HTMLElement; sig: string }
  >();

  let calOn = false;
  let calBusy = false;
  let calErr = false;
  let adRanges = new Map<number, AdRange>();
  const calValues = new Map<number, number>();
  // 校准键盘模型：设备用 bit15 标记「该键校准完成」，网页就是按这个把键染色的。
  const calFinished = new Set<number>();
  const calKeys = new Map<number, CalKeyRec>();

  let syncRt = false;

  const stepOf = (): number =>
    caps && caps.travel_precision > 0 ? caps.travel_precision / 1000 : 0.005;
  const fixed = (): number => Math.max(2, decimalsOf(stepOf()));
  const toProto = (mm: number): number => Math.max(0, Math.round(mm / stepOf()));
  const toMm = (v: number): number => v * stepOf();
  const rtMinMm = (): number =>
    caps && caps.min_rapid_trigger > 0 ? caps.min_rapid_trigger / 1000 : stepOf();
  const selIds = (): number[] => [...selected].sort((a, b) => a - b);
  /** 离开本页（main.ts 切页会把 .active 挪走）后，任何定时器都必须自己收摊，不能占着 HID。 */
  const pageAlive = (): boolean =>
    page.isConnected && page.classList.contains("active");
  const mergeSwitchTypes = (list: SwitchType[]): void => {
    for (const e of list) switchTypes.set(e.id, e.switch_type);
  };
  const axisLabelOf = (id: number): string => AXIS_LABEL.get(id) ?? `轴体 id ${id}`;
  const maxTravelOf = (id: number): number => {
    const ax = AXES.find((a) => a.id === switchTypes.get(id));
    return ax ? ax.maxTravel : DEFAULT_TRAVEL_MM;
  };

  const layerBar = el("div", { class: "layers" });
  const capsCard = el("div", { class: "card" });
  const kbCard = el("div", { class: "card" });
  const axisCard = el("div", { class: "card" });
  const testCard = el("div", { class: "card" });
  const travelCard = el("div", { class: "card" });
  const rtCard = el("div", { class: "card" });
  const dzCard = el("div", { class: "card" });
  const calCard = el("div", { class: "card" });
  page.append(
    layerBar,
    capsCard,
    kbCard,
    axisCard,
    testCard,
    travelCard,
    rtCard,
    dzCard,
    calCard,
  );

  const hintLine = (text: string): HTMLElement =>
    el("p", {
      style: "color:var(--text-faint);font-size:12px;margin:8px 0 0",
      text,
    });

  /** 卡片标题里的一行绘制帧率读数：只在运行时接上回调，停的时候固定显示「—」。 */
  const fpsReadout = (active: boolean): HTMLElement =>
    el("span", {
      class: "mono",
      style: "margin-left:10px;font-weight:400;color:var(--text-faint)",
      text: active ? fpsText : FPS_IDLE,
    });

  function mmSlider(
    label: string,
    min: number,
    max: number,
    value: number,
  ): Slider {
    const input = el("input", {
      type: "range",
      min: min.toFixed(4),
      max: max.toFixed(4),
      step: String(stepOf()),
      value: clamp(value, min, max).toFixed(4),
    });
    const out = el("span", {
      class: "mono",
      style: "min-width:170px;text-align:right",
    });
    const sync = (): void => {
      const mm = Number(input.value);
      out.textContent = `${mm.toFixed(fixed())} mm`;
    };
    input.oninput = sync;
    sync();
    return {
      input,
      out,
      sync,
      field: el(
        "label",
        { class: "field" },
        label,
        el("div", { class: "slider-row" }, input, out),
      ),
    };
  }

  function renderTabs(): void {
    layerBar.replaceChildren();
    for (const l of LAYERS) {
      const b = el("button", {
        class: `btn${l.layer === layer ? " primary" : ""}`,
        text: l.label,
      });
      b.onclick = () => {
        if (l.layer === layer) return;
        layer = l.layer;
        void reloadSelection();
      };
      layerBar.append(b);
    }
    layerBar.append(
      el("span", {
        style:
          "align-self:center;margin-left:8px;font-size:12px;color:var(--text-faint)",
        text: "系统",
      }),
    );
    for (const s of SYSTEMS) {
      const b = el("button", {
        class: `btn${s.system === system ? " primary" : ""}`,
        text: s.label,
      });
      b.onclick = () => {
        if (s.system === system) return;
        system = s.system;
        void reloadSelection();
      };
      layerBar.append(b);
    }
  }

  function renderCaps(): void {
    if (capsErr !== null || caps === null) {
      const retry = el("button", { class: "btn", text: "重试读取能力" });
      retry.onclick = () => void loadCaps();
      capsCard.replaceChildren(
        el(
          "h2",
          {},
          "设备能力",
          el("span", { class: "hint", text: "只读" }),
        ),
        el("div", {
          class: "empty",
          text: `能力读取失败${capsErr ? `：${capsErr}` : ""}。请确认设备已连接且支持磁轴触发设置，然后重试；其余卡片仍可尝试读写。`,
        }),
        retry,
      );
      return;
    }
    const c: TriggerCaps = caps;
    const stat = (k: string, v: string): HTMLElement =>
      el(
        "div",
        { class: "stat" },
        el("div", { class: "k", text: k }),
        el("div", { class: "v", text: v }),
      );
    capsCard.replaceChildren(
      el(
        "h2",
        {},
        "设备能力",
        el("span", { class: "hint", text: "只读" }),
      ),
      el(
        "div",
        { class: "row" },
        stat("行程精度", `${stepOf().toFixed(fixed())} mm`),
        stat("最小 RT", `${rtMinMm().toFixed(fixed())} mm`),
        stat("磁轴", c.magnetic ? "是" : "否"),
        stat("支持轴体", `${c.switch_ids.length} 种`),
      ),
    );
    if (!c.magnetic) {
      capsCard.append(
        el("div", {
          class: "empty",
          text: "设备没有报告任何支持的轴体 id，本机可能不是磁轴键盘；轴体下拉已退回完整本地轴体表，仍可尝试下发。",
        }),
      );
    }
  }

  async function loadCaps(): Promise<void> {
    capsErr = null;
    capsCard.replaceChildren(
      el("h2", { text: "设备能力" }),
      el("div", { class: "empty", text: "读取能力…" }),
    );
    const task = beginLoading("正在读取设备能力…");
    try {
      caps = await api.triggerCaps();
    } catch (e) {
      caps = null;
      capsErr = String(e);
    } finally {
      task.done();
    }
    renderCaps();
    renderAxis();
    renderTravel();
    renderRt();
    if (caps) void loadAllSwitchTypes();
  }

  async function loadAllSwitchTypes(): Promise<void> {
    const task = beginLoading("正在读取整盘轴体…");
    try {
      mergeSwitchTypes(
        await api.readSwitchTypes(layout68.map((k) => k.keyValue)),
      );
      renderKb();
      renderAxis();
    } catch {
      /* 整盘轴体读不出来不影响其它控件，选中键时还会再读一次 */
    } finally {
      task.done();
    }
  }

  function renderKb(): void {
    const kb = el("div", { class: "kb" });
    kb.style.width = `${930 * SCALE}px`;
    kb.style.height = `${290 * SCALE + 10}px`;
    for (const k of layout68) {
      const on = selected.has(k.keyValue);
      const key = el(
        "div",
        { class: `key${on ? " selected" : ""}` },
        el("span", { class: "cap", text: k.name }),
      );
      const ax = switchTypes.get(k.keyValue);
      if (ax !== undefined) {
        key.append(el("span", { class: "fn", text: AXIS_LABEL.get(ax) ?? `轴 ${ax}` }));
      }
      key.style.left = `${k.x * SCALE}px`;
      key.style.top = `${k.y * SCALE}px`;
      key.style.width = `${k.width * SCALE}px`;
      key.style.height = `${k.height * SCALE}px`;
      key.onclick = () => {
        if (on) selected.delete(k.keyValue);
        else selected.add(k.keyValue);
        renderKb();
        void reloadSelection();
      };
      kb.append(key);
    }
    const all = el("button", { class: "btn", text: "全选" });
    all.onclick = () => {
      for (const k of layout68) selected.add(k.keyValue);
      renderKb();
      void reloadSelection();
    };
    const none = el("button", { class: "btn", text: "清空" });
    none.onclick = () => {
      selected.clear();
      renderKb();
      void reloadSelection();
    };
    const ids = selIds();
    kbCard.replaceChildren(
      el(
        "h2",
        {},
        "选择键位",
        el("span", { class: "hint", text: "点键多选" }),
      ),
      el("div", { class: "kb-wrap" }, kb),
      el(
        "div",
        { class: "row", style: "margin-top:12px" },
        all,
        none,
        el("span", {
          class: "mono",
          style: "align-self:center",
          text: `已选 ${ids.length} 键${ids.length > 0 ? `：${ids.join(", ")}` : ""}`,
        }),
      ),
    );
  }

  async function reloadSelection(): Promise<void> {
    const token = ++selToken;
    const ids = selIds();
    if (ids.length === 0) {
      travels = new Map();
      rts = new Map();
      safes = new Map();
      renderAxis();
      renderTravel();
      renderRt();
      renderDead();
      renderCal();
      return;
    }
    const task = beginLoading("正在读取选中键的触发参数…");
    try {
      try {
        const [st, tv, rt, sa] = await Promise.all([
          api.readSwitchTypes(ids),
          api.readKeyTravel(layer, system, ids),
          api.readRapidTriggers(layer, system, ids),
          api.readSafeArea(ids),
        ]);
        if (token !== selToken) return;
        mergeSwitchTypes(st);
        travels = new Map(tv.map((e) => [e.id, e.travel]));
        rts = new Map(rt.map((e) => [e.id, e]));
        safes = new Map(sa.map((e) => [e.id, e]));
      } catch (e) {
        if (token !== selToken) return;
        toast(`读取选中键的触发参数失败：${e}`, true);
      }
      if (token !== selToken) return;
      renderKb();
      renderAxis();
      renderTravel();
      renderRt();
      renderDead();
      renderCal();
    } finally {
      task.done();
    }
  }

  async function readBackSwitchTypes(ids: number[]): Promise<void> {
    try {
      mergeSwitchTypes(await api.readSwitchTypes(ids));
    } catch {
      /* 写已经成功，读回失败就保留原显示 */
    }
    renderKb();
  }

  function renderAxis(): void {
    const ids = selIds();
    if (ids.length === 0) {
      axisCard.replaceChildren(
        el("h2", { text: "选择轴体" }),
        el("div", { class: "empty", text: "先在上方键位图中选择要设置的键。" }),
      );
      return;
    }
    const supported = caps ? caps.switch_ids : [];
    const allowed =
      supported.length > 0
        ? AXES.filter((a) => supported.includes(a.id))
        : AXES;
    const sel = el("select", { style: "min-width:320px" });
    for (const a of allowed) {
      sel.append(
        el("option", {
          value: String(a.id),
          text: `${a.label}（id ${a.id} · 最大行程 ${a.maxTravel}mm）`,
        }),
      );
    }
    const cur = switchTypes.get(ids[0]);
    if (cur !== undefined && allowed.some((a) => a.id === cur)) {
      sel.value = String(cur);
    }
    sel.disabled = allowed.length === 0;

    const apply = el("button", {
      class: "btn primary",
      text: `应用轴体到 ${ids.length} 键`,
    });
    apply.disabled = allowed.length === 0;
    apply.onclick = async () => {
      const type = Number(sel.value);
      apply.disabled = true;
      try {
        await api.writeSwitchTypes(
          ids.map((id) => ({ id, switch_type: type })),
        );
        toast(`已把「${axisLabelOf(type)}」应用到 ${ids.length} 个键`);
        await readBackSwitchTypes(ids);
      } catch (e) {
        toast(`写入轴体失败：${e}`, true);
      } finally {
        apply.disabled = false;
        renderAxis();
      }
    };

    const table = el("table", { class: "kv-table" });
    table.append(
      el(
        "tr",
        {},
        el("th", { text: "键" }),
        el("th", { text: "当前轴体" }),
        el("th", { text: "id" }),
        el("th", { text: "最大行程" }),
      ),
    );
    // 按轴体分组：全部同一种就一行写「全部 N 键」，否则每类一行并把该类按键列在同一行里。
    const groups = new Map<number | undefined, number[]>();
    for (const id of ids) {
      const t = switchTypes.get(id);
      const arr = groups.get(t);
      if (arr) arr.push(id);
      else groups.set(t, [id]);
    }
    const rows = [...groups.entries()].sort((a, b) => (a[0] ?? -1) - (b[0] ?? -1));
    for (const [t, groupIds] of rows) {
      const ax = t !== undefined ? AXES.find((a) => a.id === t) : undefined;
      const names = groupIds.map((id) => keyName(id));
      const label =
        ids.length > 1 && groupIds.length === ids.length
          ? `全部 ${ids.length} 键`
          : names.join(" · ");
      table.append(
        el(
          "tr",
          {},
          el("td", { title: names.join(" "), text: label }),
          el("td", { text: t === undefined ? "未读到" : ax ? ax.label : "未知" }),
          el("td", { text: t === undefined ? "—" : String(t) }),
          el("td", { text: ax ? `${ax.maxTravel} mm` : "—" }),
        ),
      );
    }

    axisCard.replaceChildren(
      el(
        "h2",
        {},
        "选择轴体",
        el("span", { class: "hint", text: "应用到选中键" }),
      ),
      el(
        "div",
        { class: "row" },
        el("label", { class: "field" }, "轴体", sel),
        apply,
      ),
      hintLine(
        allowed.length === 0
          ? "设备未报告可用轴体。"
          : `共 ${allowed.length} 种可选轴体。`,
      ),
      el("div", { style: "margin-top:12px" }, table),
    );
  }

  // --- 行程测试（0x98）--------------------------------------------------------

  function renderTest(): void {
    const toggle = el("button", {
      class: `btn power${testOn ? " primary" : " danger"}`,
      text: testOn ? "测试中 · 点击停止" : "OFF · 点击开始",
    });
    toggle.onclick = () => {
      if (testOn) stopTest();
      else void startTest();
    };
    const box = el("div", { style: "margin-top:10px" });
    testBarBox = box;
    testBarSig = "\u0000";
    paintBars();
    const fps = fpsReadout(testOn);
    testFpsOut = testOn ? fps : null;
    const drop = el("span", { class: "hint mono", text: "" });
    testDropOut = testOn ? drop : null;
    testCard.replaceChildren(
      el(
        "h2",
        {},
        "行程测试",
        el("span", { class: "hint", text: "实时显示按键行程" }),
        fps,
        drop,
        toggle,
      ),
      hintLine("按下按键即可看到实时行程。"),
      box,
    );
  }

  const travelDenomMm = (id: number): number => {
    const t = travels.get(id);
    if (t !== undefined && t > 0) return toMm(t);
    return maxTravelOf(id);
  };

  function paintBars(): void {
    if (!testBarBox) return;
    const now = Date.now();
    for (const [id, v] of [...live.entries()]) {
      if (now - v.at > LIVE_STALE_MS) live.delete(id);
    }
    const ids = [...live.keys()].sort((a, b) => a - b);
    const sig = ids.join(",");
    if (sig !== testBarSig) {
      testBarSig = sig;
      testBarBox.replaceChildren();
      testBars.clear();
      for (const id of ids) {
        const track = el("div", {
          style:
            "flex:1;height:10px;background:var(--bg-raise);border:1px solid var(--border);border-radius:999px;overflow:hidden",
        });
        const fill = el("div", {
          style: "height:100%;width:0%;background:var(--accent)",
        });
        track.append(fill);
        const val = el("span", {
          class: "mono",
          style: "width:190px;text-align:right",
        });
        testBarBox.append(
          el(
            "div",
            { style: "display:flex;align-items:center;gap:10px;margin:5px 0" },
            el("span", {
              style: "width:96px;font-size:12px;color:var(--text-dim)",
              text: `${keyName(id)} (${id})`,
            }),
            track,
            val,
          ),
        );
        testBars.set(id, { fill, val, sig: "" });
      }
      if (ids.length === 0) {
        testBarBox.append(
          el("div", {
            class: "empty",
            text: testOn ? "等待设备上报行程…（按住任意键）" : "未在监测。",
          }),
        );
      }
    }
    for (const id of ids) {
      const v = live.get(id);
      const bar = testBars.get(id);
      if (!v || !bar) continue;
      const denom = travelDenomMm(id);
      const pct = denom > 0 ? clamp((v.mm / denom) * 100, 0, 100) : 0;
      const width = `${pct.toFixed(1)}%`;
      const text = `${v.mm.toFixed(fixed())} / ${denom.toFixed(fixed())} mm${v.press ? " · 按下" : ""}`;
      const s = `${width}|${text}`;
      if (bar.sig === s) continue;
      bar.sig = s;
      bar.fill.style.width = width;
      bar.fill.style.background = v.press ? "var(--warn)" : "var(--accent)";
      bar.val.textContent = text;
    }
  }

  // 设备对「指定键监测」一次最多接受 28 个 id（单个请求包 56 字节）。
  // 选超过 28 个时退回「监测全部」，此时由设备自己决定上报哪些键。
  const MON_MAX_KEYS = 28;
  const monitoredIds = (): number[] => {
    const ids = selIds();
    return ids.length > 0 && ids.length <= MON_MAX_KEYS ? ids : [];
  };

  async function startTest(): Promise<void> {
    if (testTimer) {
      window.clearTimeout(testTimer);
      testTimer = 0;
    }
    if (dropTimer) {
      window.clearInterval(dropTimer);
      dropTimer = 0;
    }
    try {
      await api.startTravelMonitor(monitoredIds());
    } catch (e) {
      toast(`行程测试启动失败：${e}`, true);
      return;
    }
    testOn = true;
    testErr = false;
    live.clear();
    lastArmAt = 0;
    resetFps();
    renderTest();
    void refreshDrop();
    dropTimer = window.setInterval(() => void refreshDrop(), 500);
    void pollTravel();
  }

  function stopTest(): void {
    if (testTimer) {
      window.clearTimeout(testTimer);
      testTimer = 0;
    }
    if (dropTimer) {
      window.clearInterval(dropTimer);
      dropTimer = 0;
    }
    testOn = false;
    live.clear();
    cancelPaint(paintBars);
    void api.stopTravelMonitor().catch(() => {
      /* 设备已断开时忽略 */
    });
    renderTest();
  }

  /** 丢包计数每 500ms 刷一次（不是每帧，避免自相矛盾地制造 DOM 写入）。 */
  async function refreshDrop(): Promise<void> {
    if (!testDropOut) return;
    try {
      const n = await api.droppedReports();
      const t = `丢包 ${n}`;
      if (testDropOut.textContent !== t) testDropOut.textContent = t;
    } catch {
      /* 设备断开时忽略 */
    }
  }

  async function pollTravel(): Promise<void> {
    if (!pageAlive()) {
      stopTest();
      return;
    }
    if (testBusy || !testOn) return;
    testBusy = true;
    try {
      // 0x98/0x01 是"一次快照"而不是流：每轮都必须重发，刷新率就等于重发频率。
      const now = Date.now();
      const ids = monitoredIds();
      const needArm = now - lastArmAt >= MON_REARM_MS;
      const ev = needArm
        ? await api.pollTravelMonitor(ids, TRAVEL_WINDOW_MS)
        : await api.readTriggerEvents(TRAVEL_WINDOW_MS);
      if (needArm) lastArmAt = now;
      const at = Date.now();
      for (const s of ev.travel) {
        live.set(s.id, { mm: toMm(s.distance), press: s.press, at });
      }
      schedulePaint(paintBars);
    } catch (e) {
      if (!testErr) {
        testErr = true;
        toast(`行程数据读取失败，已停止监测：${e}`, true);
      }
      stopTest();
      return;
    } finally {
      testBusy = false;
    }
    // 收完立刻排下一轮（不 sleep）：窗口是 0，取走的只是读线程已排队的报文；绘制由 rAF 另行合并。
    if (testOn) testTimer = window.setTimeout(() => void pollTravel(), 0);
  }

  // --- 触发点 / 触发深度（0x13/0x93）—— 不是"总行程"，是"按多深才算触发" ----------

  function renderTravel(): void {
    const ids = selIds();
    if (ids.length === 0) {
      travelCard.replaceChildren(
        el("h2", { text: "触发点" }),
        el("div", { class: "empty", text: "先在上方键位图中选择要设置的键。" }),
      );
      return;
    }
    const first = ids[0];
    const proto = travels.get(first) ?? toProto(DEFAULT_TRAVEL_MM);
    const curMm = toMm(proto);
    const maxMm = Math.max(maxTravelOf(first), MIN_TRAVEL_MM, curMm);
    const sl = mmSlider(
      `触发深度（${MIN_TRAVEL_MM} .. ${maxMm.toFixed(fixed())} mm）`,
      MIN_TRAVEL_MM,
      maxMm,
      curMm,
    );
    const apply = el("button", {
      class: "btn primary",
      text: `应用触发点（${ids.length} 键）`,
    });
    apply.onclick = async () => {
      const travel = toProto(Number(sl.input.value));
      apply.disabled = true;
      try {
        await api.writeKeyTravel(
          layer,
          system,
          ids.map((id) => ({ id, travel })),
        );
        toast(
          `触发点 ${toMm(travel).toFixed(fixed())} mm 已写入 ${ids.length} 个键`,
        );
        const back = await api.readKeyTravel(layer, system, ids);
        travels = new Map(back.map((e) => [e.id, e.travel]));
      } catch (e) {
        toast(`写入行程失败：${e}`, true);
      } finally {
        apply.disabled = false;
        renderTravel();
      }
    };

    travelCard.replaceChildren(
      el(
        "h2",
        {},
        "触发点",
        el("span", { class: "hint", text: "数值越大，需要按得越深才触发" }),
      ),
      el(
        "div",
        { class: "row" },
        sl.field,
        apply,
        el("span", {
          class: "mono",
          style: "align-self:center;color:var(--text-dim)",
          text: `读回：${curMm.toFixed(fixed())} mm · 将应用到 ${ids.length} 个键`,
        }),
      ),
    );
  }

  // --- 快速触发 RT（0x19/0x99）------------------------------------------------

  function renderRt(): void {
    const ids = selIds();
    if (ids.length === 0) {
      rtCard.replaceChildren(
        el("h2", { text: "快速触发 RT" }),
        el("div", { class: "empty", text: "先在上方键位图中选择要设置的键。" }),
      );
      return;
    }
    const first = ids[0];
    const cur = rts.get(first);
    const on = cur !== undefined && cur.enable !== 0;
    const minMm = rtMinMm();
    const curPress = cur ? toMm(cur.press) : minMm;
    const curRelease = cur ? toMm(cur.release) : minMm;
    const maxMm = Math.max(
      maxTravelOf(first),
      minMm,
      curPress,
      curRelease,
      MIN_TRAVEL_MM,
    );

    const press = mmSlider("按下灵敏度", minMm, maxMm, curPress);
    const release = mmSlider("抬起灵敏度", minMm, maxMm, curRelease);
    press.input.disabled = !on;
    release.input.disabled = !on;
    press.input.oninput = () => {
      if (syncRt) {
        release.input.value = press.input.value;
        release.sync();
      }
      press.sync();
    };
    release.input.oninput = () => {
      if (syncRt) {
        press.input.value = release.input.value;
        press.sync();
      }
      release.sync();
    };

    const power = el("button", {
      class: `btn power${on ? " primary" : " danger"}`,
      text: on ? "RT ON · 点击关闭" : "RT OFF · 点击开启",
    });
    power.onclick = async () => {
      power.disabled = true;
      try {
        const list: RapidTrigger[] = ids.map((id) => {
          const r = rts.get(id);
          return {
            id,
            enable: on ? 0 : 1,
            press: r ? r.press : toProto(minMm),
            release: r ? r.release : toProto(minMm),
          };
        });
        await api.writeRapidTriggers(layer, system, list);
        toast(
          on
            ? `已关闭 ${ids.length} 个键的快速触发`
            : `已开启 ${ids.length} 个键的快速触发（灵敏度沿用设备现值）`,
        );
        rts = new Map(
          (await api.readRapidTriggers(layer, system, ids)).map((e) => [e.id, e]),
        );
      } catch (e) {
        toast(`写入 RT 总开关失败：${e}`, true);
      } finally {
        renderRt();
      }
    };

    // 「同步设置按下与抬起」在协议里没有对应字段：纯 UI 开关，打开时改一条滑杆会镜像另一条，
    // 下发时仍是 press / release 两个字段各写一次。
    const syncBox = el("input", { type: "checkbox" });
    syncBox.checked = syncRt;
    syncBox.onchange = () => {
      syncRt = syncBox.checked;
      if (syncRt) {
        release.input.value = press.input.value;
        release.sync();
      }
    };

    const apply = el("button", {
      class: "btn primary",
      text: `应用灵敏度（${ids.length} 键）`,
    });
    apply.disabled = !on;
    apply.onclick = async () => {
      const pressV = toProto(Number(press.input.value));
      const releaseV = toProto(Number(release.input.value));
      apply.disabled = true;
      try {
        await api.writeRapidTriggers(
          layer,
          system,
          ids.map((id) => ({ id, enable: 1, press: pressV, release: releaseV })),
        );
        toast(
          `RT 灵敏度已写入 ${ids.length} 个键（按下 ${toMm(pressV).toFixed(fixed())} / 抬起 ${toMm(releaseV).toFixed(fixed())} mm）`,
        );
        rts = new Map(
          (await api.readRapidTriggers(layer, system, ids)).map((e) => [e.id, e]),
        );
      } catch (e) {
        toast(`写入 RT 灵敏度失败：${e}`, true);
      } finally {
        renderRt();
      }
    };

    rtCard.replaceChildren(
      el(
        "h2",
        {},
        "快速触发 RT",
        el("span", { class: "hint", text: "按下与抬起灵敏度" }),
        power,
      ),
      el(
        "div",
        { class: "row" },
        press.field,
        release.field,
        el(
          "label",
          { class: "field" },
          "同步设置按下与抬起",
          el("div", { style: "display:flex;align-items:center;gap:8px" }, syncBox),
        ),
        apply,
      ),
      hintLine(
        on
          ? `已开启；最小灵敏度 ${minMm.toFixed(fixed())} mm。`
          : "先开启总开关再调灵敏度。",
      ),
    );
  }

  // --- 高级设置：顶部 / 底部死区（0x16/0x96）----------------------------------

  function renderDead(): void {
    const ids = selIds();
    if (ids.length === 0) {
      dzCard.replaceChildren(
        el("h2", { text: "高级设置 · 死区" }),
        el("div", { class: "empty", text: "先在上方键位图中选择要设置的键。" }),
      );
      return;
    }
    const first = ids[0];
    const cur = safes.get(first);
    const topMm = cur ? toMm(cur.top) : 0;
    const botMm = cur ? toMm(cur.bottom) : 0;
    let dzOn = cur !== undefined && cur.enable !== 0;

    const top = mmSlider(
      `顶部死区（0 .. ${MAX_DEAD_ZONE_MM} mm）`,
      0,
      MAX_DEAD_ZONE_MM,
      topMm,
    );
    const bottom = mmSlider(
      `底部死区（0 .. ${MAX_DEAD_ZONE_MM} mm）`,
      0,
      MAX_DEAD_ZONE_MM,
      botMm,
    );

    const power = el("button", { class: "btn" });
    const paint = (): void => {
      power.textContent = dzOn ? "死区 ON · 点击关闭" : "死区 OFF · 点击开启";
      power.className = `btn${dzOn ? " primary" : " danger"}`;
    };
    power.onclick = () => {
      dzOn = !dzOn;
      paint();
    };
    paint();

    const apply = el("button", {
      class: "btn primary",
      text: `应用死区（${ids.length} 键）`,
    });
    apply.onclick = async () => {
      const topV = toProto(Number(top.input.value));
      const botV = toProto(Number(bottom.input.value));
      apply.disabled = true;
      try {
        await api.writeSafeArea(
          ids.map((id) => ({
            id,
            top: topV,
            bottom: botV,
            enable: dzOn ? 1 : 0,
          })),
        );
        toast(
          `死区已写入 ${ids.length} 个键（顶部 ${toMm(topV).toFixed(fixed())} / 底部 ${toMm(botV).toFixed(fixed())} mm，${dzOn ? "启用" : "禁用"}）`,
        );
        safes = new Map(
          (await api.readSafeArea(ids)).map((e) => [e.id, e]),
        );
      } catch (e) {
        toast(`写入死区失败：${e}`, true);
      } finally {
        apply.disabled = false;
        renderDead();
      }
    };

    dzCard.replaceChildren(
      el(
        "h2",
        {},
        "高级设置 · 死区",
        el("span", { class: "hint", text: "应用到选中键" }),
      ),
      el("div", { class: "row" }, top.field, bottom.field, power, apply),
      hintLine(
        `读回：顶部 ${topMm.toFixed(fixed())} / 底部 ${botMm.toFixed(fixed())} mm，${cur && cur.enable !== 0 ? "已启用" : "未启用"}。`,
      ),
    );
  }

  // --- 轴体校准（0x94/0x00 起 · 0x94/0x04 停 · 0x94/param=2 上报）-------------

  function renderCal(): void {
    const ids = selIds();
    const toggle = el("button", {
      class: `btn power${calOn ? " primary" : " danger"}`,
      text: calOn ? "校准中 · 点击停止" : "OFF · 点击开始",
    });
    toggle.disabled = ids.length === 0;
    toggle.onclick = () => {
      if (calOn) stopCal();
      else void startCal();
    };
    const box = el("div", { style: "margin-top:10px" });
    calKeys.clear();
    // 像网页那样用标准键位模型展示：每键显示实时数值，校准完成的键染绿。
    const kb = el("div", { class: "kb" });
    kb.style.width = `${930 * SCALE}px`;
    kb.style.height = `${290 * SCALE + 10}px`;
    for (const k of layout68) {
      const cap = el("span", { class: "cap", text: k.name });
      const val = el("span", { class: "fn", text: "" });
      const key = el("div", { class: "key" }, cap, val);
      key.style.left = `${k.x * SCALE}px`;
      key.style.top = `${k.y * SCALE}px`;
      key.style.width = `${k.width * SCALE}px`;
      key.style.height = `${k.height * SCALE}px`;
      const hit = ids.includes(k.keyValue);
      if (hit) key.style.borderColor = "var(--accent-dim)";
      calKeys.set(k.keyValue, { key, cap, val, sig: "" });
      kb.append(key);
    }
    box.append(el("div", { class: "kb-wrap" }, kb));
    if (ids.length === 0) {
      box.append(el("div", { class: "empty", text: "先选键再校准（选中键会高亮边框）。" }));
    }
    const fps = fpsReadout(calOn);
    calFpsOut = calOn ? fps : null;
    calCard.replaceChildren(
      el(
        "h2",
        {},
        "轴体校准",
        el("span", { class: "hint", text: "逐个按键到底完成校准" }),
        fps,
        toggle,
      ),
      hintLine("按键按到底完成校准，完成的键会高亮。"),
      box,
    );
    paintCal();
  }

  function paintCal(): void {
    for (const [id, rec] of calKeys) {
      const finished = calFinished.has(id);
      const p = calValues.get(id);
      const text = finished
        ? p === undefined
          ? "✓ 完成"
          : `✓ ${p.toFixed(0)}%`
        : p === undefined
          ? ""
          : `${p.toFixed(0)}%`;
      // finished 进签名：由 true 变回 false 时要走 else 分支把染色和文字恢复默认。
      const sig = `${finished ? "f" : "n"}|${text}`;
      if (rec.sig === sig) continue;
      rec.sig = sig;
      if (finished) {
        rec.key.style.background = "var(--accent)";
        rec.cap.style.color = "#06231f";
        rec.val.style.color = "#06231f";
      } else {
        rec.key.style.background = "";
        rec.cap.style.color = "";
        rec.val.style.color = "";
      }
      rec.val.textContent = text;
    }
  }

  async function startCal(): Promise<void> {
    const ids = selIds();
    if (ids.length === 0) {
      toast("先在键位图中选择要校准的键", true);
      return;
    }
    try {
      adRanges = new Map((await api.readAdRange(ids)).map((r) => [r.id, r]));
      await api.startCalibration();
    } catch (e) {
      toast(`校准启动失败：${e}`, true);
      return;
    }
    calOn = true;
    calErr = false;
    calValues.clear();
    calFinished.clear();
    resetFps();
    renderCal();
    calReplayTimer = window.setInterval(() => {
      if (!pageAlive()) {
        stopCal();
        return;
      }
      void api.startCalibration().catch(() => {
        /* 单次重发失败不打断校准 */
      });
    }, CAL_REPLAY_MS);
    calPollTimer = window.setTimeout(() => void pollCal(), 0);
  }
  function stopCal(): void {
    if (calPollTimer) {
      window.clearTimeout(calPollTimer);
      calPollTimer = 0;
    }
    if (calReplayTimer) {
      window.clearInterval(calReplayTimer);
      calReplayTimer = 0;
    }
    calOn = false;
    cancelPaint(paintCal);
    void api.stopCalibration().catch(() => {
      /* 设备已断开时忽略 */
    });
    renderCal();
  }

  async function pollCal(): Promise<void> {
    if (!pageAlive()) {
      stopCal();
      return;
    }
    if (calBusy || !calOn) return;
    calBusy = true;
    try {
      const ev = await api.readTriggerEvents(CAL_WINDOW_MS);
      for (const s of ev.calibration) {
        if (s.finished) calFinished.add(s.id);
        else calFinished.delete(s.id);
        const r = adRanges.get(s.id);
        if (!r) continue;
        const span = r.max - r.min;
        calValues.set(
          s.id,
          span > 0 ? clamp(Math.max(0, ((r.max - s.ad) / span) * 100), 0, 100) : 0,
        );
      }
      schedulePaint(paintCal);
    } catch (e) {
      if (!calErr) {
        calErr = true;
        toast(`校准进度读取失败，已停止校准：${e}`, true);
      }
      stopCal();
      return;
    } finally {
      calBusy = false;
    }
    // 与行程测试同样：非阻塞取走读线程已排队的报文，取完立刻排下一轮；绘制由 rAF 另行合并。
    if (calOn) calPollTimer = window.setTimeout(() => void pollCal(), 0);
  }

  renderTabs();
  renderKb();
  renderAxis();
  renderTravel();
  renderRt();
  renderDead();
  renderTest();
  renderCal();
  await loadCaps();
}
