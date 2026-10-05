import {
  api,
  type KeyColor,
  type LightingOverview,
  type Rgb,
  type ZoneEffect,
} from "../api";
import { effects, layout68, type EffectEntry } from "../data";
import { el, toast } from "../ui";

/** 键位图缩放（与改键页一致）。 */
const SCALE = 1.12;

const DIRECTIONS = ["无 / 正向", "反向 / 左", "右", "上", "下"];
const MAX_LIGHTBOX_CELLS = 400;

// --- 「开灯」要写回的 effect id 记忆 -----------------------------------------
//
// 官方网页的 OFF/ON 开关就是 `setEffect`（`0x04/<base>`）写 effectId 0/1，而且
// 「开」被硬编码成 1（常亮）——并不恢复关灯前的效果。本驱动改成记住原值：
// 关灯前把当前非 0 的 effect id 存进 localStorage（按板载配置分键，因为灯光是
// 按配置存的），开灯时写回它；没有记录时退回 1，对齐官方行为。
//
// 键的映射（真机实测，HERO 68 XS 有线）：主灯 `0x01`、侧灯(氛围) `0x06`；
// Logo/灯箱两个区在本机型上写入被 ACK 但读回不变（不存在），能力块也不报告。

function powerMemKey(profile: number, base: number): string {
  return `aula.light.power.${profile}.${base}`;
}

/** 关灯前记住的效果 id；没有记录返回 null。 */
function recallEffect(profile: number, base: number): number | null {
  const raw = localStorage.getItem(powerMemKey(profile, base));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 256 ? n : null;
}

/** 记住当前效果 id（0 = 关灯，不覆盖记忆）。 */
function rememberEffect(profile: number, base: number, id: number): void {
  if (id > 0) localStorage.setItem(powerMemKey(profile, base), String(id));
}

const rgbToHex = (c: Rgb): string =>
  `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const hexToRgb = (s: string): Rgb => ({
  r: parseInt(s.slice(1, 3), 16),
  g: parseInt(s.slice(3, 5), 16),
  b: parseInt(s.slice(5, 7), 16),
});
const rgbText = (c: Rgb): string =>
  `${c.r.toString(16).padStart(2, "0")} ${c.g.toString(16).padStart(2, "0")} ${c.b.toString(16).padStart(2, "0")}`;

function field(label: string, input: HTMLElement): HTMLElement {
  return el("label", { class: "field" }, label, input);
}

/** 官方灯光页的展示顺序：`关闭` 恒在最前，其余按表里的 UI 顺序，表外 id 追加在后。
 *  官方页面「灯效模式」的排布与 id 顺序不一致（见 effects.json 的 uiOrder）。 */
function orderedEffects(list: EffectEntry[], order: number[]): EffectEntry[] {
  const byId = new Map(list.map((e) => [e.id, e]));
  const out: EffectEntry[] = [];
  const off = byId.get(0);
  if (off) out.push(off);
  for (const id of order) {
    const e = byId.get(id);
    if (e && !out.includes(e)) out.push(e);
  }
  for (const e of list) if (!out.includes(e)) out.push(e);
  return out;
}

/** 该灯区用的名称表：侧灯（氛围灯效）走氛围表，其余走键盘灯效表。 */
function effectTable(base: number): { list: EffectEntry[]; order: number[] } {
  return base === 6
    ? { list: effects.side, order: effects.sideUiOrder }
    : { list: effects.keyboard, order: effects.keyboardUiOrder };
}

export async function renderLighting(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "灯光" }),
    el("p", {
      class: "sub",
      text: "四个灯区（0x84 读 / 0x04 写整块）+ 全键单色 / 每键改色（0x08）+ 灯箱矩阵（0x29）。亮度 UI 1..22 ↔ 协议 0..21，速度 UI 1..6 ↔ 协议 0..5。",
    }),
  );

  let overview: LightingOverview | null = null;
  let profile = 0;
  let activeBase = 1;
  // 每键改色的待下发颜色与选中键。
  const pending = new Map<number, Rgb>();
  const selected = new Set<number>();
  let brush: Rgb = { r: 0x35, g: 0xe0, b: 0xd6 };
  // 灯箱矩阵颜色（row-major）。
  let lbColors: Rgb[] = [];
  let lbBrush: Rgb = { r: 255, g: 255, b: 255 };

  const capsCard = el("div", { class: "card" });
  const zoneCard = el("div", { class: "card" });
  const fullCard = el("div", { class: "card" });
  const perkeyCard = el("div", { class: "card" });
  const lbCard = el("div", { class: "card" });
  page.append(capsCard, zoneCard, fullCard, perkeyCard, lbCard);

  async function load(): Promise<void> {
    try {
      profile = await api.getProfile().catch(() => profile);
      overview = await api.lightingOverview();
      if (overview.caps && overview.caps.lightbox_rows > 0 && overview.caps.lightbox_cols > 0) {
        const n = overview.caps.lightbox_rows * overview.caps.lightbox_cols;
        if (lbColors.length !== n) {
          lbColors = Array.from({ length: n }, () => ({ r: 0, g: 0, b: 0 }));
        }
      }
    } catch (e) {
      overview = null;
      zoneCard.replaceChildren(
        el("h2", { text: "灯区效果" }),
        el("div", { class: "empty", text: `读取失败: ${e}` }),
      );
      return;
    }
    renderAll();
  }

  function renderCaps(): void {
    if (!overview) return;
    const c = overview.caps;
    capsCard.replaceChildren(el("h2", { text: "灯光能力" }, el("span", { class: "hint", text: "0x82/0x09" })));
    if (!c) {
      capsCard.append(el("div", { class: "empty", text: "能力探测失败，下方按各区域实际读取结果显示。" }));
      return;
    }
    const row = el("div", { class: "row" });
    const stat = (k: string, v: string) =>
      el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: v }));
    row.append(
      stat("侧灯（氛围）", c.side_light ? `有 (${c.side_beads} 灯珠)` : "无"),
      stat("Logo 灯", c.logo_light ? "有" : "无"),
      stat("灯箱矩阵", c.lightbox_rows > 0 ? `${c.lightbox_rows} × ${c.lightbox_cols}` : "无"),
      stat("方向支持", c.direction_supported ? "是" : "否"),
      stat("灯箱效果位图", `0x${c.effect_bitmap.toString(16).padStart(2, "0")}`),
      stat(
        "音乐灯",
        [c.music_main && "主灯", c.music_spectrum && "频谱", c.music_side && "侧灯"].filter(Boolean).join("/") || "无",
      ),
      stat("当前配置", `#${profile}`),
    );
    capsCard.append(row);
  }

  function renderZone(): void {
    if (!overview) return;
    const z = overview.zones.find((z) => z.base === activeBase)!;
    if (!z.supported) {
      zoneCard.replaceChildren(
        el("h2", { text: "灯区效果" }),
        el("div", { class: "empty", text: `${z.name}：此设备不支持该区域（能力探测），已禁用。` }),
      );
      return;
    }
    if (!z.effect) {
      zoneCard.replaceChildren(
        el("h2", { text: "灯区效果" }),
        el("div", { class: "empty", text: `${z.name}：读取失败${z.error ? ` (${z.error})` : ""}。` }),
      );
      return;
    }
    const e = z.effect;
    const on = e.effect_id !== 0;
    const { list, order } = effectTable(z.base);
    const bitmap = overview.caps ? overview.caps.effect_bitmap : null;

    const ciSel = el("select", { style: "min-width:150px" });
    for (let i = 0; i <= 6; i++) ciSel.append(el("option", { value: String(i), text: `固定色 ${i}` }));
    ciSel.append(el("option", { value: "7", text: "随机（多彩）" }));
    ciSel.value = String(e.color_index);

    const colorIn = el("input", { type: "color", value: rgbToHex(e.color) });
    const briIn = el("input", { type: "range", min: "1", max: "22", value: String(e.brightness + 1) });
    const spdIn = el("input", { type: "range", min: "1", max: "6", value: String(e.speed + 1) });
    const briVal = el("span", { class: "mono", text: String(e.brightness + 1) });
    const spdVal = el("span", { class: "mono", text: String(e.speed + 1) });
    briIn.oninput = () => (briVal.textContent = briIn.value);
    spdIn.oninput = () => (spdVal.textContent = spdIn.value);

    let dirSel: HTMLSelectElement | null = null;
    if (z.base === 1 && overview.caps?.direction_supported) {
      dirSel = el("select", { style: "min-width:150px" });
      DIRECTIONS.forEach((n, i) => dirSel!.append(el("option", { value: String(i), text: `${i} ${n}` })));
      dirSel.value = String(e.direction ?? 0);
    }

    /** 用当前控件值组装一次整块写入（effect id 由调用方指定）。 */
    const readForm = (effectId: number): ZoneEffect => ({
      effect_id: effectId,
      color_index: Number(ciSel.value),
      color: hexToRgb(colorIn.value),
      brightness: Number(briIn.value) - 1,
      speed: Number(spdIn.value) - 1,
      direction: dirSel ? Number(dirSel.value) : null,
    });

    async function apply(next: ZoneEffect, note: string): Promise<void> {
      try {
        await api.setZoneEffect(z.base, next);
        rememberEffect(profile, z.base, next.effect_id);
        toast(`${z.name}: ${note}`);
        await load(); // 写后读回，界面显示的一定是设备实际状态
      } catch (err) {
        alert(`写入失败: ${err}`);
      }
    }

    // 灯效模式网格（官方 UI 顺序）；点一下即下发。
    const grid = el("div", { class: "modes" });
    for (const fx of orderedEffects(list, order)) {
      const isOff = fx.id === 0;
      const active = isOff ? !on : on && e.effect_id === fx.id;
      const b = el("button", {
        class: `btn mode${active ? " primary" : ""}${isOff ? " off" : ""}`,
        text: fx.name,
      });
      if (bitmap !== null && bitmap > 0 && fx.id >= 1 && (bitmap & (1 << (fx.id - 1))) === 0) {
        b.title = "能力位图未声明支持此效果（仍可尝试下发）";
      }
      b.onclick = () => void apply(readForm(fx.id), isOff ? "已关灯" : `灯效 → ${fx.name}（id=${fx.id}）`);
      grid.append(b);
    }

    // OFF/ON 开关：关灯写 0，开灯写回记忆里的原效果（没有记忆则 1）。
    const power = el("button", {
      class: `btn power${on ? " primary" : " danger"}`,
      text: on ? "ON · 点击关灯" : "OFF · 点击开灯",
    });
    power.onclick = () => {
      if (on) {
        void apply(readForm(0), "已关灯");
      } else {
        const id = recallEffect(profile, z.base) ?? 1;
        void apply(readForm(id), `已开灯（effect=${id}）`);
      }
    };

    const applyBtn = el("button", { class: "btn", text: "应用颜色 / 亮度 / 速度" });
    applyBtn.onclick = () => void apply(readForm(e.effect_id), "参数已下发");

    const rows: HTMLElement[] = [
      el("div", { class: "row" }, field("颜色模式", ciSel), field("颜色", colorIn)),
      el(
        "div",
        { class: "row" },
        field("亮度 (1..22)", el("div", { class: "slider-row" }, briIn, briVal)),
        field("速度 (1..6)", el("div", { class: "slider-row" }, spdIn, spdVal)),
      ),
    ];
    if (dirSel) rows.push(el("div", { class: "row" }, field("方向（仅主灯）", dirSel)));

    zoneCard.replaceChildren(
      el(
        "h2",
        {},
        `灯区效果 — ${z.name}`,
        el("span", { class: "hint", text: `0x84/${z.base} 读 / 0x04/${z.base} 写` }),
        power,
      ),
      el("div", { class: "block-label", text: "灯效模式" }),
      grid,
      ...rows,
      el(
        "div",
        { class: "row", style: "margin-top:14px" },
        applyBtn,
        el("span", {
          class: "hint mono",
          text: `读回: effect=${e.effect_id} colorIndex=${e.color_index} rgb=${rgbText(e.color)} 亮度=${e.brightness} 速度=${e.speed}${e.direction !== null ? ` 方向=${e.direction}` : ""}`,
        }),
      ),
    );
  }

  function renderZoneTabs(): void {
    if (!overview) return;
    // 防累积：先清掉旧 tab 条再插入。
    page.querySelectorAll(":scope > .layers").forEach((n) => n.remove());
    const tabs = el("div", { class: "layers" });
    for (const z of overview.zones) {
      const state = z.supported ? "" : "（无）";
      const live = z.effect && z.effect.effect_id !== 0 ? " · 亮" : "";
      const b = el("button", {
        class: `btn${z.base === activeBase ? " primary" : ""}`,
        text: z.name + state + live,
      });
      b.onclick = () => {
        activeBase = z.base;
        renderZoneTabs();
        renderZone();
      };
      tabs.append(b);
    }
    zoneCard.before(tabs);
  }

  function renderFull(): void {
    const colorIn = el("input", { type: "color", value: rgbToHex(brush) });
    const apply = el("button", { class: "btn primary", text: "全键应用" });
    apply.onclick = async () => {
      apply.disabled = true;
      try {
        await api.setFullKeysRgb(hexToRgb(colorIn.value));
        toast("全键颜色已下发");
      } catch (err) {
        alert(`写入失败: ${err}`);
      } finally {
        apply.disabled = false;
      }
    };
    fullCard.replaceChildren(
      el("h2", { text: "全键单色" }, el("span", { class: "hint", text: "0x08/2" })),
      el("div", { class: "row" }, field("颜色", colorIn), apply),
    );
  }

  function renderPerkey(): void {
    const colorIn = el("input", { type: "color", value: rgbToHex(brush) });
    colorIn.oninput = () => (brush = hexToRgb(colorIn.value));
    const paint = el("button", { class: "btn", text: "给选中键上色" });
    paint.disabled = selected.size === 0;
    paint.onclick = () => {
      for (const id of selected) pending.set(id, brush);
      renderPerkey();
    };
    const send = el("button", { class: "btn primary", text: `下发全部改动 (${pending.size})` });
    send.disabled = pending.size === 0;
    send.onclick = async () => {
      send.disabled = true;
      try {
        const entries: KeyColor[] = [...pending.entries()].map(([id, color]) => ({ id, color }));
        await api.setKeyColors(entries);
        pending.clear();
        toast("每键颜色已下发");
        renderPerkey();
      } catch (err) {
        alert(`写入失败: ${err}`);
      } finally {
        send.disabled = false;
      }
    };
    const clear = el("button", { class: "btn", text: "清空" });
    clear.onclick = () => {
      pending.clear();
      selected.clear();
      renderPerkey();
    };
    // 0x06/0 把逐键颜色写进板载自定义灯区（effectId 19「自定义」），掉电不丢；
    // 0x08/1 只是即时刷灯。固件对 0x86/0 的多 id 批量读会错位，所以逐个读回。
    const persist = el("button", { class: "btn", text: `保存到自定义区 (${pending.size})` });
    persist.disabled = pending.size === 0;
    persist.onclick = async () => {
      persist.disabled = true;
      try {
        const entries: KeyColor[] = [...pending.entries()].map(([id, color]) => ({ id, color }));
        await api.writeCustomColors(entries);
        toast(`已持久化 ${entries.length} 个键（effectId 19 自定义）`);
      } catch (err) {
        alert(`写入失败: ${err}`);
      } finally {
        persist.disabled = false;
      }
    };
    const pull = el("button", { class: "btn", text: `读回选中键 (${selected.size})` });
    pull.disabled = selected.size === 0;
    pull.onclick = async () => {
      pull.disabled = true;
      try {
        let n = 0;
        for (const id of selected) {
          pending.set(id, await api.readCustomColor(id));
          n++;
        }
        toast(`已从设备读回 ${n} 个键的自定义色`);
        renderPerkey();
      } catch (err) {
        alert(`读取失败: ${err}`);
      } finally {
        pull.disabled = false;
      }
    };

    const kb = el("div", { class: "kb" });
    kb.style.width = `${930 * SCALE}px`;
    kb.style.height = `${290 * SCALE + 10}px`;
    for (const k of layout68) {
      const c = pending.get(k.keyValue);
      const key = el(
        "div",
        { class: `key${selected.has(k.keyValue) ? " selected" : ""}` },
        el("span", { class: "cap", text: k.name }),
      );
      key.style.left = `${k.x * SCALE}px`;
      key.style.top = `${k.y * SCALE}px`;
      key.style.width = `${k.width * SCALE}px`;
      key.style.height = `${k.height * SCALE}px`;
      if (c) {
        key.style.background = rgbToHex(c);
        key.querySelector(".cap")!.textContent = "";
      }
      key.onclick = () => {
        if (selected.has(k.keyValue)) selected.delete(k.keyValue);
        else selected.add(k.keyValue);
        renderPerkey();
      };
      kb.append(key);
    }

    perkeyCard.replaceChildren(
      el(
        "h2",
        { text: "每键改色" },
        el("span", { class: "hint", text: "0x08/1 即时下发（按颜色聚类）；0x06 持久化到自定义区；点键多选" }),
      ),
      el("div", { class: "kb-wrap" }, kb),
      el("div", { class: "row", style: "margin-top:12px" }, field("画笔颜色", colorIn), paint, send, persist, pull, clear),
    );
  }

  function renderLightbox(): void {
    const c = overview?.caps;
    if (!c || c.lightbox_rows <= 0 || c.lightbox_cols <= 0) {
      lbCard.replaceChildren();
      return;
    }
    const n = c.lightbox_rows * c.lightbox_cols;
    if (n > MAX_LIGHTBOX_CELLS) {
      lbCard.replaceChildren(
        el("h2", { text: "灯箱矩阵" }),
        el("div", { class: "empty", text: `矩阵 ${c.lightbox_rows}×${c.lightbox_cols} 过大，未渲染（上限 ${MAX_LIGHTBOX_CELLS} 格）。` }),
      );
      return;
    }
    const colorIn = el("input", { type: "color", value: rgbToHex(lbBrush) });
    colorIn.oninput = () => (lbBrush = hexToRgb(colorIn.value));
    const grid = el("div", { class: "lb-grid" });
    grid.style.gridTemplateColumns = `repeat(${c.lightbox_cols}, 16px)`;
    lbColors.forEach((cellColor, i) => {
      const cell = el("div", { class: "lb-cell" });
      cell.style.background = rgbToHex(cellColor);
      cell.onclick = () => {
        lbColors[i] = lbBrush;
        renderLightbox();
      };
      grid.append(cell);
    });
    const send = el("button", { class: "btn primary", text: "下发灯箱" });
    send.onclick = async () => {
      send.disabled = true;
      try {
        await api.setLightboxColors(lbColors);
        toast("灯箱矩阵已下发");
      } catch (err) {
        alert(`写入失败: ${err}`);
      } finally {
        send.disabled = false;
      }
    };
    lbCard.replaceChildren(
      el("h2", { text: "灯箱矩阵" }, el("span", { class: "hint", text: `0x29/3，RGB565，${c.lightbox_rows}×${c.lightbox_cols}` })),
      el("div", { class: "row", style: "margin-bottom:12px" }, field("画笔颜色", colorIn), send),
      grid,
    );
  }

  function renderAll(): void {
    // 清理旧 tabs（renderZoneTabs 用 before 插入）。
    page.querySelectorAll(":scope > .layers").forEach((n) => n.remove());
    renderCaps();
    renderZoneTabs();
    renderZone();
    renderFull();
    renderPerkey();
    renderLightbox();
  }

  await load();
}
