import { api, type KeyEntry } from "../api";
import { keycodeName, layout68, pickerGroups } from "../data";
import { el } from "../ui";

const LAYERS = [
  { label: "基础层", layer: 0 },
  { label: "Fn 层", layer: 1 },
  { label: "Fn1 层", layer: 2 },
];

const SCALE = 1.12;

export async function renderKeymap(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "改键" }),
    el("p", {
      class: "sub",
      text: "三层键位映射（0x83 读 / 0x03 写，每包 9 条）。点击键位，右侧选择新键码后应用。",
    }),
  );

  let layer = 0;
  let current = new Map<number, number>();
  const pending = new Map<number, number>();
  let selectedId: number | null = null;

  const tabs = el("div", { class: "layers" });
  const kbCard = el("div", { class: "card" });
  const pickCard = el("div", { class: "card" });
  page.append(tabs, kbCard, pickCard);

  async function load(): Promise<void> {
    kbCard.replaceChildren(el("h2", { text: "键位图" }), el("div", { class: "empty", text: "读取键位…" }));
    try {
      const ids = layout68.map((k) => k.keyValue);
      const entries: KeyEntry[] = await api.readKeymap(layer, 0, ids);
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
      const key = el(
        "div",
        { class: `key${selectedId === k.keyValue ? " selected" : ""}` },
        el("span", { class: "cap", text: keycodeName(kc) }),
        el("span", { class: "fn", text: changed ? "●" : k.name }),
      );
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
      el("h2", {}, `键位图 — ${LAYERS[layer].label}`, el("span", { class: "hint", text: "● = 待应用" })),
      el("div", { class: "kb-wrap" }, kb),
    );
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
    pickCard.replaceChildren(
      el("h2", {}, `键码选择 — ${selKey.name} (id ${selectedId})`),
      el("p", {
        class: "sub",
        text: `当前: ${keycodeName(cur)} (0x${cur.toString(16).padStart(8, "0")})`,
      }),
    );
    for (const g of pickerGroups) {
      const select = el("select", { style: "min-width:340px" });
      select.append(el("option", { value: "", text: `选择… (${g.label})` }));
      for (const e of g.entries) {
        const opt = el("option", { value: String(e.browserValue), text: e.defaultKey });
        select.append(opt);
      }
      select.onchange = () => {
        if (select.value === "") return;
        pending.set(selectedId!, Number(select.value));
        renderKb();
        renderPicker();
      };
      pickCard.append(el("div", { class: "row", style: "margin-bottom:10px" }, el("label", { class: "field" }, `${g.label} `, select)));
    }
    const actions = el(
      "div",
      { class: "row", style: "margin-top:16px" },
    );
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
      if (selectedId === null) return;
      pending.set(selectedId, selKey.defaultKeycode);
      renderKb();
      renderPicker();
    };
    const clear = el("button", { class: "btn", text: "放弃改动" });
    clear.onclick = () => {
      pending.clear();
      renderKb();
      renderPicker();
    };
    actions.append(apply, revert, clear);
    pickCard.append(actions);
  }

  function renderAll(): void {
    renderKb();
    renderPicker();
  }

  await load();
}
