import { api, toHex, type Macro, type MacroAction, type MacroRegion } from "../api";
import { keyboardMap, keycodes, layout68 } from "../data";
import { el, toast } from "../ui";

const BYTE_KEYS = keycodes.filter((k) => k.value <= 255);
const KINDS: Array<[number, string]> = [
  [0, "按下"],
  [1, "抬起"],
];
/** bits4-6 是动作类别（SDK 枚举 `a8`），不是设备类型。 */
const CATEGORIES: Array<[number, string]> = [
  [0, "普通按键"],
  [1, "修饰键"],
  [2, "鼠标"],
  [3, "MouseX"],
  [4, "MouseY"],
  [5, "滚轮"],
];
const CAT_NORMAL = 0;
const CAT_MODIFIER = 1;
const CAT_MOUSE = 2;
/** 鼠标按键：动作码 0..4 → 位掩码（页面 SDK 实测）。 */
const MOUSE_BUTTONS: Array<[number, string]> = [
  [0x01, "左键"],
  [0x04, "中键"],
  [0x02, "右键"],
  [0x08, "后退"],
  [0x10, "前进"],
];
const LAYERS = [
  { label: "基础层", layer: 0 },
  { label: "Fn 层", layer: 1 },
  { label: "Fn1 层", layer: 2 },
];
const LOOP_TYPES: Array<[number, string]> = [
  [1, "指定次数"],
  [2, "重复直至任意键按下"],
  [3, "按住重复，松开停止"],
];
const MAX_DELAY = 0xfffff;
const enc = new TextEncoder();

const macroBytes = (m: Macro): number =>
  4 * m.actions.length + enc.encode(m.name).length + 1;
const estimateTotal = (list: Macro[]): number =>
  4 * list.length + list.reduce((s, m) => s + macroBytes(m), 0);
const byteName = (v: number): string =>
  BYTE_KEYS.find((k) => k.value === v)?.name ?? "";
const mouseButtonName = (v: number): string =>
  MOUSE_BUTTONS.find(([bit]) => bit === v)?.[1] ?? "";
/** 键盘动作该用哪个类别：0xE0-0xE7 是修饰键，其余是普通按键。 */
const keyboardCategory = (keycode: number): number =>
  keycode >= 0xe0 && keycode <= 0xe7 ? CAT_MODIFIER : 0;
/** 该类别下键码的显示名：鼠标动作的键码是按键位掩码，键盘动作是 HID 用途码。 */
const actionByteName = (v: number, category: number): string =>
  category === CAT_MOUSE ? mouseButtonName(v) : byteName(v);

function parseByte(s: string): number | null {
  const t = s.trim().toLowerCase();
  let n = NaN;
  if (/^0x[0-9a-f]{1,2}$/.test(t)) n = parseInt(t, 16);
  else if (/^\d{1,3}$/.test(t)) n = parseInt(t, 10);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

function hidFromEvent(e: KeyboardEvent): number {
  const byName = BYTE_KEYS.find((k) => k.name === e.code);
  if (byName) return byName.value;
  const hit = keyboardMap.find((m) => m.browserCode === e.code);
  if (hit && hit.browserValue <= 255) return hit.browserValue;
  return 0;
}

export async function renderMacros(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "宏" }),
    el("p", {
      class: "sub",
      text: "录制或编辑宏，并绑定到任意层的按键。",
    }),
  );

  let region: MacroRegion | null = null;
  let macros: Macro[] = [];
  let sel: number | null = null;
  let dirty = false;
  let recording = false;
  let recLast = 0;
  let recWarned = false;
  let renameIdx: number | null = null;
  let bindToken = 0;

  const bind = {
    macroIdx: 0,
    layer: 0,
    loopType: 1,
    loopCount: 1,
    keyId: layout68[0].keyValue,
    orig: null as number | null,
  };

  const capCard = el("div", { class: "card" });
  const listCard = el("div", { class: "card" });
  const editCard = el("div", { class: "card" });
  const bindCard = el("div", { class: "card" });
  const rawCard = el("div", { class: "card" });
  page.append(capCard, listCard, editCard, bindCard, rawCard);

  function refreshCap(): void {
    const cap = region?.capacity ?? 0;
    const used = estimateTotal(macros);
    const pct = cap > 0 ? (used / cap) * 100 : 0;
    const over = used > cap;
    const saveBtn = el("button", { class: "btn primary", text: "保存到设备" });
    saveBtn.disabled = !dirty || recording;
    saveBtn.onclick = () => void save();
    const addBtn = el("button", { class: "btn", text: "新建宏" });
    addBtn.disabled = recording;
    addBtn.onclick = () => {
      macros.push({ name: `宏 ${macros.length + 1}`, actions: [] });
      sel = macros.length - 1;
      dirty = true;
      renderAll();
    };
    const reloadBtn = el("button", { class: "btn", text: "重新读取" });
    reloadBtn.onclick = () => void load();
    capCard.replaceChildren(
      el(
        "h2",
        {},
        "容量",
        el("span", {
          class: "hint",
          text: "按字节估算",
        }),
      ),
      el(
        "div",
        {
          class: "mono",
          text: `已用 ${used} / ${cap} 字节 (${pct.toFixed(1)}%)${dirty ? " — 有未保存改动" : ""}`,
        },
      ),
      el(
        "div",
        {
          style:
            "height:8px;background:var(--bg-raise);border:1px solid var(--border-strong);border-radius:999px;overflow:hidden;margin:10px 0 14px",
        },
        el("div", {
          style: `height:100%;width:${Math.min(100, pct).toFixed(1)}%;background:${over ? "var(--danger)" : "var(--accent)"}`,
        }),
      ),
      el("div", { class: "row" }, addBtn, saveBtn, reloadBtn),
      el("p", {
        class: "hint",
        style: "margin:10px 0 0",
        text: "⚠ 保存会整段回写：不在列表里的宏会被擦除。",
      }),
    );
  }

  async function save(): Promise<void> {
    if (!dirty || !region) return;
    const est = estimateTotal(macros);
    if (est > region.capacity && !window.confirm(`估算 ${est} 字节已超出容量 ${region.capacity}，仍要写入吗？`)) return;
    // 设备按本次写入长度截断宏区，这里必须提交完整列表。
    if (!window.confirm(`即将整段回写宏区（估算 ${est} 字节），本次列表之外的宏会被擦除，确认保存全部 ${macros.length} 个宏？`)) return;
    try {
      const n = await api.writeMacroSet(macros);
      dirty = false;
      toast(`已写入 ${n} 字节`);
      await load();
    } catch (e) {
      toast(`写入失败: ${e}`, true);
      refreshCap();
    }
  }

  function renderList(): void {
    const head = el(
      "h2",
      {},
      "宏列表",
      el("span", { class: "hint", text: "改动需保存后才生效" }),
    );
    if (macros.length === 0) {
      listCard.replaceChildren(
        head,
        el("div", {
          class: "empty",
          text: region?.empty ? "设备上还没有宏，点「新建宏」开始。" : "没有宏。",
        }),
      );
      return;
    }
    const table = el("table", { class: "kv-table" });
    table.append(
      el(
        "tr",
        {},
        el("th", { text: "#" }),
        el("th", { text: "名称" }),
        el("th", { text: "动作数" }),
        el("th", { text: "字节数" }),
        el("th", { text: "操作" }),
      ),
    );
    macros.forEach((m, i) => {
      const nameCell = el("td");
      if (renameIdx === i) {
        const input = el("input", { type: "text", value: m.name, style: "width:160px" });
        const ok = el("button", { class: "btn", text: "确定", style: "padding:4px 10px;margin-left:6px" });
        const cancel = el("button", { class: "btn", text: "取消", style: "padding:4px 10px;margin-left:6px" });
        const commit = () => {
          const v = input.value.trim();
          if (v) {
            macros[i].name = v;
            dirty = true;
          }
          renameIdx = null;
          renderAll();
        };
        input.onchange = commit;
        ok.onclick = commit;
        cancel.onclick = () => {
          renameIdx = null;
          renderList();
        };
        nameCell.append(input, ok, cancel);
      } else {
        const span = el("span", {
          text: m.name,
          style: `cursor:pointer;${sel === i ? "color:var(--accent);font-weight:600" : ""}`,
        });
        span.onclick = () => {
          sel = i;
          renameIdx = null;
          renderAll();
        };
        nameCell.append(span);
      }
      const opCell = el("td");
      const mk = (label: string, fn: () => void, danger = false) => {
        const b = el("button", {
          class: `btn${danger ? " danger" : ""}`,
          text: label,
          style: "padding:4px 10px;margin-right:6px",
        });
        b.onclick = (ev) => {
          ev.stopPropagation();
          fn();
        };
        opCell.append(b);
      };
      mk("重命名", () => {
        renameIdx = i;
        renderList();
      });
      mk("复制", () => {
        macros.splice(i + 1, 0, {
          name: `${m.name} 副本`,
          actions: m.actions.map((a) => ({ ...a })),
        });
        sel = i + 1;
        dirty = true;
        renderAll();
      });
      mk("↑", () => {
        if (i === 0) return;
        [macros[i - 1], macros[i]] = [macros[i], macros[i - 1]];
        if (sel === i) sel = i - 1;
        else if (sel === i - 1) sel = i;
        dirty = true;
        renderAll();
      });
      mk("↓", () => {
        if (i >= macros.length - 1) return;
        [macros[i + 1], macros[i]] = [macros[i], macros[i + 1]];
        if (sel === i) sel = i + 1;
        else if (sel === i + 1) sel = i;
        dirty = true;
        renderAll();
      });
      mk("删除", () => {
        if (!window.confirm(`删除宏「${m.name}」？（保存后生效）`)) return;
        macros.splice(i, 1);
        if (sel === i) sel = macros.length ? Math.min(i, macros.length - 1) : null;
        else if (sel !== null && sel > i) sel -= 1;
        dirty = true;
        renderAll();
      }, true);
      table.append(
        el(
          "tr",
          {},
          el("td", { text: String(i) }),
          nameCell,
          el("td", { text: String(m.actions.length) }),
          el("td", { text: String(macroBytes(m)) }),
          opCell,
        ),
      );
    });
    listCard.replaceChildren(head, table);
  }

  function actionRow(a: MacroAction, i: number, list: MacroAction[]): HTMLElement {
    const idx = el("td", { text: String(i), style: "color:var(--text-faint)" });
    const kindSel = el("select");
    for (const [v, n] of KINDS) kindSel.append(el("option", { value: String(v), text: n }));
    kindSel.value = String(a.kind);
    kindSel.onchange = () => {
      a.kind = Number(kindSel.value);
      dirty = true;
      refreshCap();
    };
    const catSel = el("select");
    for (const [v, n] of CATEGORIES) catSel.append(el("option", { value: String(v), text: n }));
    catSel.value = String(a.category);
    catSel.onchange = () => {
      a.category = Number(catSel.value);
      fillKcOptions();
      dirty = true;
      refreshCap();
    };
    const delayInput = el("input", {
      type: "number",
      min: "0",
      max: String(MAX_DELAY),
      value: String(a.delay),
      style: "width:100px",
    });
    delayInput.onchange = () => {
      const n = Math.max(0, Math.min(MAX_DELAY, Math.round(Number(delayInput.value) || 0)));
      a.delay = n;
      delayInput.value = String(n);
      dirty = true;
      refreshCap();
    };

    const kcSel = el("select", { style: "max-width:220px" });
    const kcInput = el("input", {
      type: "text",
      value: `0x${toHex(a.keycode)}`,
      style: "width:70px",
      class: "mono",
    });
    const kcName = el("span", {
      class: "mono",
      style: "color:var(--text-dim)",
      text: actionByteName(a.keycode, a.category),
    });
    /** 类别决定可选的键码表：鼠标动作的字节是按键位掩码，不是 HID 用途码。 */
    const kcOptions = (): Array<[number, string]> =>
      a.category === CAT_MOUSE ? MOUSE_BUTTONS : BYTE_KEYS.map((k) => [k.value, k.name]);
    const fillKcOptions = (): void => {
      kcSel.replaceChildren(el("option", { value: "", text: "自定义…" }));
      for (const [value, name] of kcOptions()) {
        kcSel.append(
          el("option", { value: String(value), text: `${name} (0x${toHex(value)})` }),
        );
      }
      kcSel.value = kcOptions().some(([value]) => value === a.keycode) ? String(a.keycode) : "";
      kcName.textContent = actionByteName(a.keycode, a.category);
    };
    const syncKc = (v: number) => {
      a.keycode = v;
      // 键盘动作的类别由键码决定：0xE0-0xE7 必须是"修饰键"，否则按下/抬起不生效。
      if (a.category === CAT_NORMAL || a.category === CAT_MODIFIER) {
        a.category = keyboardCategory(v);
        catSel.value = String(a.category);
      }
      kcInput.value = `0x${toHex(v)}`;
      kcInput.style.borderColor = "";
      kcSel.value = kcOptions().some(([value]) => value === v) ? String(v) : "";
      kcName.textContent = actionByteName(v, a.category);
      dirty = true;
      refreshCap();
    };
    fillKcOptions();
    kcSel.onchange = () => {
      if (kcSel.value === "") {
        kcInput.focus();
        return;
      }
      syncKc(Number(kcSel.value));
    };
    kcInput.onchange = () => {
      const v = parseByte(kcInput.value);
      if (v === null) {
        kcInput.style.borderColor = "var(--danger)";
        toast(`无效键码「${kcInput.value}」，应为 0-255（十进制或 0x 十六进制）`, true);
        return;
      }
      syncKc(v);
    };

    const ops = el("td");
    const mk = (label: string, fn: () => void) => {
      const b = el("button", {
        class: "btn",
        text: label,
        style: "padding:3px 9px;margin-right:4px",
      });
      b.onclick = fn;
      ops.append(b);
    };
    mk("↑", () => {
      if (i === 0) return;
      [list[i - 1], list[i]] = [list[i], list[i - 1]];
      dirty = true;
      renderEditor();
    });
    mk("↓", () => {
      if (i >= list.length - 1) return;
      [list[i + 1], list[i]] = [list[i], list[i + 1]];
      dirty = true;
      renderEditor();
    });
    mk("删", () => {
      list.splice(i, 1);
      dirty = true;
      renderAll();
    });
    return el(
      "tr",
      {},
      idx,
      el("td", {}, kindSel),
      el("td", {}, catSel),
      el("td", {}, delayInput),
      el("td", {}, kcSel, " ", kcInput, " ", kcName),
      ops,
    );
  }

  function onRecKey(e: KeyboardEvent): void {
    if (!recording || sel === null || sel >= macros.length) return;
    e.preventDefault();
    if (e.type === "keydown" && e.code === "Escape") {
      stopRec();
      return;
    }
    if (e.repeat) return;
    const now = performance.now();
    const delay = recLast > 0 ? Math.min(MAX_DELAY, Math.max(0, Math.round(now - recLast))) : 0;
    recLast = now;
    const keycode = hidFromEvent(e);
    if (keycode === 0 && !recWarned) {
      recWarned = true;
      toast(`按键 ${e.code || e.key} 无法识别，已记为 0，可稍后手改`, true);
    }
    macros[sel].actions.push({
      kind: e.type === "keydown" ? 0 : 1,
      category: keyboardCategory(keycode),
      delay,
      keycode,
    });
    dirty = true;
    renderList();
    renderEditor();
    refreshCap();
  }

  function startRec(): void {
    recording = true;
    recLast = 0;
    recWarned = false;
    window.addEventListener("keydown", onRecKey, true);
    window.addEventListener("keyup", onRecKey, true);
    renderEditor();
    refreshCap();
  }

  function stopRec(): void {
    if (!recording) return;
    recording = false;
    window.removeEventListener("keydown", onRecKey, true);
    window.removeEventListener("keyup", onRecKey, true);
    renderEditor();
    refreshCap();
  }

  function renderEditor(): void {
    if (sel === null || sel >= macros.length) {
      editCard.replaceChildren(
        el("h2", { text: "动作编辑" }),
        el("div", { class: "empty", text: "先在上方列表选择一个宏。" }),
      );
      return;
    }
    const m = macros[sel];
    const nameInput = el("input", { type: "text", value: m.name, style: "min-width:220px" });
    nameInput.oninput = () => {
      m.name = nameInput.value;
      dirty = true;
      refreshCap();
      renderList();
    };
    const recBtn = el("button", {
      class: `btn${recording ? " danger" : ""}`,
      text: recording ? "停止录制" : "开始录制",
    });
    recBtn.onclick = () => {
      if (recording) stopRec();
      else startRec();
    };
    const addBtn = el("button", { class: "btn", text: "添加动作" });
    addBtn.disabled = recording;
    addBtn.onclick = () => {
      m.actions.push({ kind: 0, category: CAT_NORMAL, delay: 0, keycode: 0 });
      dirty = true;
      renderAll();
    };
    const head = el(
      "h2",
      {},
      `动作编辑 — #${sel}`,
      el("span", { class: "hint", text: `${m.name}（${m.actions.length} 个动作）` }),
    );
    const controls = el(
      "div",
      { class: "row", style: "margin-bottom:14px" },
      el("label", { class: "field" }, "宏名称", nameInput),
      recBtn,
      addBtn,
    );
    if (recording) {
      controls.append(
        el("span", { class: "hint", text: "正在录制：按键会被记录，Esc 停止。" }),
      );
    }
    if (m.actions.length === 0) {
      editCard.replaceChildren(
        head,
        controls,
        el("div", { class: "empty", text: "暂无动作。点「添加动作」或「开始录制」。" }),
      );
      return;
    }
    const table = el("table", { class: "kv-table" });
    table.append(
      el(
        "tr",
        {},
        el("th", { text: "#" }),
        el("th", { text: "类型" }),
        el("th", { text: "设备" }),
        el("th", { text: "延时 (ms)" }),
        el("th", { text: "键码" }),
        el("th", { text: "操作" }),
      ),
    );
    m.actions.forEach((a, i) => table.append(actionRow(a, i, m.actions)));
    editCard.replaceChildren(head, controls, table);
  }

  function bindKeycode(): number {
    const loopCount = bind.loopType === 1 ? Math.max(0, Math.min(255, bind.loopCount)) : 0;
    // 宏键码公式：type 0x03 | loopType<<16 | loopCount<<8 | macroIndex
    return ((3 << 24) | (bind.loopType << 16) | (loopCount << 8) | bind.macroIdx) >>> 0;
  }

  async function updateBindOrig(): Promise<void> {
    const t = ++bindToken;
    bind.orig = null;
    renderBind();
    try {
      const [entry] = await api.readKeymap(bind.layer, 0, [bind.keyId]);
      if (t !== bindToken) return;
      bind.orig = entry.keycode;
    } catch {
      if (t === bindToken) toast("读取原键位失败", true);
    }
    renderBind();
  }

  function renderBind(): void {
    const head = el(
      "h2",
      {},
      "绑定到键",
      el("span", { class: "hint", text: "把宏绑定到指定键" }),
    );
    if (macros.length === 0) {
      bindCard.replaceChildren(head, el("div", { class: "empty", text: "没有可绑定的宏。" }));
      return;
    }
    bind.macroIdx = Math.min(bind.macroIdx, macros.length - 1);

    const macroSel = el("select", { style: "min-width:200px" });
    const bindable = Math.min(macros.length, 256);
    for (let i = 0; i < bindable; i++) {
      macroSel.append(el("option", { value: String(i), text: `#${i} ${macros[i].name}` }));
    }
    macroSel.value = String(bind.macroIdx);
    macroSel.onchange = () => {
      bind.macroIdx = Number(macroSel.value);
      renderBind();
    };
    if (macros.length > 256) {
      macroSel.append(
        el("option", { value: "", text: `其余 ${macros.length - 256} 个宏超出下标上限，不可绑定` }),
      );
    }

    const layerSel = el("select");
    for (const l of LAYERS) layerSel.append(el("option", { value: String(l.layer), text: l.label }));
    layerSel.value = String(bind.layer);
    layerSel.onchange = () => {
      bind.layer = Number(layerSel.value);
      void updateBindOrig();
    };

    const loopSel = el("select", { style: "min-width:180px" });
    for (const [v, n] of LOOP_TYPES) loopSel.append(el("option", { value: String(v), text: n }));
    loopSel.value = String(bind.loopType);
    loopSel.onchange = () => {
      bind.loopType = Number(loopSel.value);
      renderBind();
    };

    const countInput = el("input", {
      type: "number",
      min: "0",
      max: "255",
      value: String(bind.loopCount),
      style: "width:90px",
    });
    countInput.onchange = () => {
      bind.loopCount = Math.max(0, Math.min(255, Math.round(Number(countInput.value) || 0)));
      renderBind();
    };

    const keySel = el("select", { style: "min-width:200px" });
    for (const k of layout68) {
      keySel.append(el("option", { value: String(k.keyValue), text: `${k.name} (id ${k.keyValue})` }));
    }
    keySel.value = String(bind.keyId);
    keySel.onchange = () => {
      bind.keyId = Number(keySel.value);
      void updateBindOrig();
    };

    const kc = bindKeycode();
    const fields: HTMLElement[] = [
      el("label", { class: "field" }, "宏", macroSel),
      el("label", { class: "field" }, "层", layerSel),
      el("label", { class: "field" }, "循环方式", loopSel),
    ];
    if (bind.loopType === 1) fields.push(el("label", { class: "field" }, "循环次数", countInput));
    fields.push(el("label", { class: "field" }, "目标键", keySel));

    const bindBtn = el("button", { class: "btn primary", text: "绑定" });
    bindBtn.onclick = async () => {
      bindBtn.disabled = true;
      try {
        await api.writeKeymap(bind.layer, 0, [{ id: bind.keyId, keycode: kc }]);
        const layerName = LAYERS.find((l) => l.layer === bind.layer)?.label ?? `层 ${bind.layer}`;
        const keyName = layout68.find((k) => k.keyValue === bind.keyId)?.name ?? String(bind.keyId);
        toast(`已绑定宏 #${bind.macroIdx} 到 ${layerName} 的 ${keyName}`);
        await updateBindOrig();
      } catch (e) {
        toast(`绑定失败: ${e}`, true);
      } finally {
        bindBtn.disabled = false;
      }
    };
    const restoreBtn = el("button", { class: "btn", text: "还原原键位" });
    restoreBtn.disabled = bind.orig === null;
    restoreBtn.onclick = async () => {
      if (bind.orig === null) return;
      restoreBtn.disabled = true;
      try {
        await api.writeKeymap(bind.layer, 0, [{ id: bind.keyId, keycode: bind.orig }]);
        toast("已还原原键位");
      } catch (e) {
        toast(`还原失败: ${e}`, true);
      } finally {
        restoreBtn.disabled = false;
      }
    };

    bindCard.replaceChildren(
      head,
      el("div", { class: "row", style: "margin-bottom:12px" }, ...fields),
      el(
        "div",
        { class: "row", style: "margin-bottom:12px" },
        bindBtn,
        restoreBtn,
        el("span", {
          class: "mono",
          text: `${bind.loopType === 1 ? `重复 ${Math.max(0, Math.min(255, bind.loopCount))} 次` : LOOP_TYPES.find(([v]) => v === bind.loopType)?.[1]}`,
        }),
      ),
      el("div", {
        class: "sub",
        style: "margin:0",
        text:
          bind.orig !== null
            ? bind.orig !== 0
              ? `该键当前已绑定「${byteName(bind.orig & 0xff) || "其他功能"}」`
              : "该键当前未绑定功能"
            : "读取原键位中…",
      }),
    );
  }

  function renderRaw(): void {
    const summary = el(
      "summary",
      { style: "cursor:pointer;color:var(--text-dim);font-size:13px" },
      "原始区域（排错用）",
    );
    const body = region
      ? el(
          "div",
          { style: "margin-top:12px" },
          el(
            "div",
            { class: "row", style: "margin-bottom:10px" },
            el("div", { class: "stat" }, el("div", { class: "k", text: "HEADER LEN" }), el("div", { class: "v", text: String(region.header_len) })),
            el("div", { class: "stat" }, el("div", { class: "k", text: "TOTAL LEN" }), el("div", { class: "v", text: String(region.total_len) })),
            el("div", { class: "stat" }, el("div", { class: "k", text: "EMPTY" }), el("div", { class: "v", text: region.empty ? "是" : "否" })),
          ),
          el("div", {
            class: "log",
            style: "max-height:180px",
            text: region.raw ? region.raw.slice(0, 1024) + (region.raw.length > 1024 ? " …" : "") : "（无数据）",
          }),
        )
      : el("div", { class: "empty", text: "尚未读取。" });
    const det = el("details", {}, summary, body);
    rawCard.replaceChildren(det);
  }

  function renderAll(): void {
    refreshCap();
    renderList();
    renderEditor();
    renderBind();
    renderRaw();
  }

  async function load(): Promise<void> {
    stopRec();
    renameIdx = null;
    listCard.replaceChildren(
      el("h2", { text: "宏列表" }),
      el("div", { class: "empty", text: "读取宏区…" }),
    );
    try {
      region = await api.readMacroSet();
      macros = region.macros.map((m) => ({
        name: m.name,
        actions: m.actions.map((a) => ({ ...a })),
      }));
      sel = macros.length > 0 ? 0 : null;
      dirty = false;
      bind.macroIdx = 0;
    } catch (e) {
      listCard.replaceChildren(
        el("h2", { text: "宏列表" }),
        el("div", { class: "empty", text: `读取失败: ${e}` }),
      );
      return;
    }
    renderAll();
    await updateBindOrig();
  }

  await load();
}
