import { api, type KeyEntry, type Macro } from "../api";
import {
  keycodeName,
  keyboardMap,
  layout68,
  type KeyboardMapEntry,
} from "../data";
import { el, toast } from "../ui";

const LAYERS = [
  { label: "基础层", layer: 0 },
  { label: "Fn 层", layer: 1 },
  { label: "Fn1 层", layer: 2 },
];

const SCALE = 1.12;

const hex8 = (n: number): string =>
  `0x${n.toString(16).padStart(8, "0").toUpperCase()}`;

// keyboardMap[].type：0 = 系统 / 1 = Ctrl组合 / 2 = Alt组合 / 3 = Win组合 / 4 = 鼠标 / 5 = 媒体；缺省 = 普通键盘键。
const PICKER_GROUPS: Array<{
  label: string;
  match: (e: KeyboardMapEntry) => boolean;
}> = [
  { label: "普通键", match: (e) => e.type === undefined },
  { label: "系统", match: (e) => e.type === 0 },
  { label: "Ctrl 组合", match: (e) => e.type === 1 },
  { label: "Alt 组合", match: (e) => e.type === 2 },
  { label: "Win 组合", match: (e) => e.type === 3 },
  { label: "鼠标", match: (e) => e.type === 4 },
  { label: "媒体", match: (e) => e.type === 5 },
];

const MACRO_LOOP_TYPES = [
  { value: 1, label: "指定次数（≥1）" },
  { value: 2, label: "重复直至任意键按下" },
  { value: 3, label: "按住重复，松开停止" },
];

function parseHexInput(s: string): number | null {
  const t = s.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{1,8}$/i.test(t)) return null;
  return parseInt(t, 16);
}

function matchEntry(e: KeyboardMapEntry, q: string): boolean {
  const s = q.toLowerCase();
  if (e.defaultKey.toLowerCase().includes(s)) return true;
  if (e.browserCode.toLowerCase().includes(s)) return true;
  return e.browserValue
    .toString(16)
    .padStart(8, "0")
    .includes(s.replace(/^0x/, ""));
}

export async function renderKeymap(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "改键" }),
    el("p", {
      class: "sub",
      text: "三层键位映射：基础层 (layer 0) / Fn 层 (layer 1) / Fn1 层 (layer 2)，param = (layer & 3) | ((system & 7) << 2)（0x83 读 / 0x03 写）。点击键位后在下方选择新键码、搜索、手输 hex 或绑定宏；宏键码 = (3<<24) | (循环方式<<16) | (次数<<8) | 宏下标（循环方式：1 = 指定次数，2 = 重复直至任意键按下，3 = 按住重复松开停止），全部改动由「应用全部改动」统一写入。",
    }),
  );

  let layer = 0;
  let current = new Map<number, number>();
  const pending = new Map<number, number>();
  let selectedId: number | null = null;
  let advancedIds = new Set<number>();

  let searchText = "";
  let hexDraft = "";

  let macros: Macro[] | null = null;
  let macroErr: string | null = null;
  let macroReady = false;
  let macroIndex = 0;
  let macroLoopType = 1;
  let macroCount = 1;

  const tabs = el("div", { class: "layers" });
  const kbCard = el("div", { class: "card" });
  const pickCard = el("div", { class: "card" });
  page.append(tabs, kbCard, pickCard);

  function loadMacros(): void {
    api
      .readMacroSet()
      .then((r) => {
        macros = r.macros;
      })
      .catch((e) => {
        macroErr = String(e);
      })
      .finally(() => {
        macroReady = true;
        renderPicker();
      });
  }

  async function refreshAdvanced(): Promise<void> {
    try {
      const entries = await api.readAdvanced(layer, 0);
      advancedIds = new Set(
        entries
          .filter((e) => e.key !== null && e.key.kind !== 0)
          .map((e) => e.id),
      );
    } catch {
      advancedIds = new Set();
    }
  }

  async function load(): Promise<void> {
    kbCard.replaceChildren(el("h2", { text: "键位图" }), el("div", { class: "empty", text: "读取键位…" }));
    try {
      const ids = layout68.map((k) => k.keyValue);
      const [entries] = await Promise.all([
        api.readKeymap(layer, 0, ids),
        refreshAdvanced(),
      ]);
      current = new Map(entries.map((e) => [e.id, e.keycode]));
      pending.clear();
      selectedId = null;
    } catch (e) {
      kbCard.replaceChildren(
        el("h2", { text: "键位图" }),
        el("div", { class: "empty", text: `读取失败: ${e}` }),
      );
      return;
    }
    renderAll();
  }

  function renderTabs(): void {
    tabs.replaceChildren();
    for (const l of LAYERS) {
      const b = el("button", {
        class: `btn${l.layer === layer ? " primary" : ""}`,
        text: l.label,
      });
      b.onclick = () => {
        layer = l.layer;
        void load();
      };
      tabs.append(b);
    }
  }

  function renderKb(): void {
    renderTabs();
    const kb = el("div", { class: "kb" });
    kb.style.width = `${930 * SCALE}px`;
    kb.style.height = `${290 * SCALE + 10}px`;
    for (const k of layout68) {
      const kc = pending.get(k.keyValue) ?? current.get(k.keyValue) ?? k.defaultKeycode;
      const changed = pending.has(k.keyValue);
      const adv = advancedIds.has(k.keyValue);
      const key = el(
        "div",
        {
          class: `key${selectedId === k.keyValue ? " selected" : ""}`,
          ...(adv ? { title: "已配置高级功能" } : {}),
        },
        el("span", { class: "cap", text: keycodeName(kc) }),
        el("span", { class: "fn", text: changed ? "●" : k.name }),
        el("span", { class: "fn", text: hex8(kc) }),
      );
      if (adv) {
        key.append(
          el("span", {
            style:
              "position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:var(--accent);pointer-events:none",
          }),
        );
      }
      key.style.left = `${k.x * SCALE}px`;
      key.style.top = `${k.y * SCALE}px`;
      key.style.width = `${k.width * SCALE}px`;
      key.style.height = `${k.height * SCALE}px`;
      key.onclick = () => {
        selectedId = k.keyValue;
        renderKb();
        renderPicker();
      };
      kb.append(key);
    }
    kbCard.replaceChildren(
      el(
        "h2",
        {},
        `键位图 — ${LAYERS[layer].label}`,
        el("span", { class: "hint", text: "● = 待应用 · 右上角圆点 = 高级键" }),
      ),
      el("div", { class: "kb-wrap" }, kb),
    );
  }

  function groupBlock(
    label: string,
    entries: KeyboardMapEntry[],
    open: boolean,
  ): HTMLElement {
    const box = el("div", { style: "display:flex;flex-wrap:wrap;gap:4px;padding:6px 0 10px" });
    for (const e of entries) {
      const b = el("button", {
        class: "btn",
        style: "padding:2px 8px;font-size:11px",
        title: `${e.defaultKey} · ${hex8(e.browserValue)}${e.browserCode ? ` · ${e.browserCode}` : ""}`,
        text: e.defaultKey,
      });
      b.onclick = () => {
        if (selectedId === null) return;
        pending.set(selectedId, e.browserValue);
        renderKb();
        renderPicker();
      };
      box.append(b);
    }
    return el(
      "details",
      open ? { open: "" } : {},
      el("summary", { style: "cursor:pointer;font-size:12.5px;color:var(--text-dim)", text: label }),
      box,
    );
  }

  function buildMacroBlock(): HTMLElement {
    const wrap = el("div", {
      style: "margin-top:14px;border-top:1px solid var(--border);padding-top:2px",
    });
    wrap.append(el("div", { class: "block-label", text: "宏绑定" }));
    if (!macroReady) {
      wrap.append(el("div", { class: "empty", text: "读取宏列表…" }));
      return wrap;
    }
    if (macroErr !== null) {
      wrap.append(
        el("div", {
          class: "empty",
          text: `宏列表读取失败，宏绑定不可用（${macroErr}）。可先检查设备连接，或改用 hex 手输宏键码。`,
        }),
      );
      return wrap;
    }
    const list = macros ?? [];
    if (list.length === 0) {
      wrap.append(el("div", { class: "empty", text: "设备上没有已保存的宏，请先在「宏」页录制后再绑定。" }));
      return wrap;
    }

    macroIndex = Math.min(macroIndex, list.length - 1);
    const idxSel = el("select", { style: "min-width:240px" });
    list.forEach((m, i) => {
      idxSel.append(el("option", { value: String(i), text: `#${i} ${m.name}（${m.actions.length} 动作）` }));
    });
    idxSel.value = String(macroIndex);

    const loopSel = el("select", { style: "min-width:180px" });
    for (const t of MACRO_LOOP_TYPES) {
      loopSel.append(el("option", { value: String(t.value), text: t.label }));
    }
    loopSel.value = String(macroLoopType);

    const countInput = el("input", {
      type: "number",
      min: "1",
      max: "255",
      style: "width:70px",
      value: String(macroCount),
    });

    const readout = el("p", { class: "sub" });
    const bind = el("button", { class: "btn primary", text: "绑定到选中键（填入待应用）" });

    const compute = (): number => {
      macroIndex = Number(idxSel.value);
      macroLoopType = Number(loopSel.value);
      if (macroLoopType === 1) {
        countInput.disabled = false;
        const n = Math.trunc(Number(countInput.value));
        macroCount = Number.isFinite(n) ? Math.min(255, Math.max(1, n)) : 1;
      } else {
        countInput.disabled = true;
        macroCount = 0;
        countInput.value = "0";
      }
      return (3 << 24) | (macroLoopType << 16) | (macroCount << 8) | macroIndex;
    };
    const sync = (): void => {
      const kc = compute();
      readout.textContent = `宏键码 = ${keycodeName(kc)} (${hex8(kc)})`;
    };
    idxSel.onchange = sync;
    loopSel.onchange = sync;
    countInput.oninput = sync;
    countInput.onchange = (): void => {
      if (macroLoopType === 1) countInput.value = String(macroCount);
    };
    bind.onclick = (): void => {
      if (selectedId === null) return;
      pending.set(selectedId, compute());
      toast("已填入待应用，点「应用全部改动」写入键盘");
      renderKb();
      renderPicker();
    };

    wrap.append(
      el(
        "div",
        { class: "row" },
        el("label", { class: "field" }, "宏 ", idxSel),
        el("label", { class: "field" }, "循环方式 ", loopSel),
        el("label", { class: "field" }, "次数 ", countInput),
      ),
      readout,
      bind,
    );
    sync();
    return wrap;
  }

  function renderPicker(): void {
    if (selectedId === null) {
      pickCard.replaceChildren(
        el("h2", { text: "键码选择" }),
        el("div", { class: "empty", text: "先在上方键位图中选择一个键。" }),
      );
      return;
    }
    const selKey = layout68.find((k) => k.keyValue === selectedId)!;
    const cur = pending.get(selectedId) ?? current.get(selectedId) ?? selKey.defaultKeycode;

    const searchInput = el("input", {
      type: "search",
      placeholder: "搜索键名 / browserCode / hex（如 Space、KeyA、0x00000029）",
      style: "min-width:340px",
      value: searchText,
    });
    const groupsWrap = el("div", {});
    const renderGroups = (): void => {
      groupsWrap.replaceChildren();
      const q = searchText.trim();
      if (q !== "") {
        const hits = keyboardMap.filter((e) => matchEntry(e, q));
        groupsWrap.append(groupBlock(`搜索结果（${hits.length}）`, hits, true));
      } else {
        for (const g of PICKER_GROUPS) {
          const entries = keyboardMap.filter(g.match);
          if (entries.length > 0) {
            groupsWrap.append(groupBlock(`${g.label}（${entries.length}）`, entries, g.label === "普通键"));
          }
        }
      }
    };
    searchInput.oninput = (): void => {
      searchText = searchInput.value;
      renderGroups();
    };

    const hexInput = el("input", {
      placeholder: "0x00000029 或 29",
      style: "width:130px",
      value: hexDraft,
    });
    const hexInfo = el("span", { class: "hint" });
    const hexBtn = el("button", { class: "btn", text: "填入待应用" });
    const syncHex = (): void => {
      hexDraft = hexInput.value;
      const v = parseHexInput(hexInput.value);
      if (v === null) {
        hexInfo.textContent = hexInput.value.trim() === "" ? "" : "无法解析（1~8 位十六进制）";
        hexBtn.disabled = true;
      } else {
        hexInfo.textContent = `${keycodeName(v)} · ${hex8(v)}`;
        hexBtn.disabled = false;
      }
    };
    hexInput.oninput = syncHex;
    hexBtn.onclick = (): void => {
      const v = parseHexInput(hexInput.value);
      if (v === null || selectedId === null) return;
      pending.set(selectedId, v);
      renderKb();
      renderPicker();
    };

    const apply = el("button", { class: "btn primary", text: `应用全部改动 (${pending.size})` });
    apply.disabled = pending.size === 0;
    apply.onclick = async () => {
      apply.disabled = true;
      try {
        const entries: KeyEntry[] = [...pending.entries()].map(([id, keycode]) => ({ id, keycode }));
        await api.writeKeymap(layer, 0, entries);
        for (const [id, kc] of pending) current.set(id, kc);
        pending.clear();
        renderKb();
        renderPicker();
      } catch (e) {
        alert(`写入失败: ${e}`);
      } finally {
        apply.disabled = false;
      }
    };
    const revert = el("button", { class: "btn", text: "还原默认 (选中键)" });
    revert.onclick = () => {
      pending.set(selectedId!, selKey.defaultKeycode);
      renderKb();
      renderPicker();
    };
    const clear = el("button", { class: "btn", text: "放弃改动" });
    clear.onclick = () => {
      pending.clear();
      renderKb();
      renderPicker();
    };

    pickCard.replaceChildren(
      el("h2", {}, `键码选择 — ${selKey.name} (id ${selectedId})`),
      el("p", { class: "sub", text: `当前: ${keycodeName(cur)} (${hex8(cur)})` }),
      el("div", { class: "row" }, el("label", { class: "field" }, "搜索 ", searchInput)),
      el(
        "div",
        { class: "row" },
        el("label", { class: "field" }, "hex ", hexInput, " ", hexInfo),
        hexBtn,
      ),
      groupsWrap,
      buildMacroBlock(),
      el("div", { class: "row", style: "margin-top:16px" }, apply, revert, clear),
    );
    renderGroups();
    syncHex();
  }

  function renderAll(): void {
    renderKb();
    renderPicker();
  }

  loadMacros();
  await load();
}
