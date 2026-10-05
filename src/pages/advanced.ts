import {
  api,
  toHex,
  type AdvancedEntry,
  type AdvancedGroup,
  type AdvancedKey,
} from "../api";
import { keycodeName, keycodes, layout68 } from "../data";
import { el, toast } from "../ui";

const LAYERS = [
  { label: "基础层", layer: 0 },
  { label: "Fn 层", layer: 1 },
  { label: "Fn1 层", layer: 2 },
];

const KINDS = [
  { kind: 1, tag: "TGL", name: "切换开关", desc: "单击按键可开关持续触发" },
  { kind: 2, tag: "MT", name: "按住/单击", desc: "区分点击与长按，分别触发不同功能" },
  { kind: 3, tag: "DKS", name: "动态键程", desc: "按按压深度绑定 1~4 种功能" },
  { kind: 4, tag: "SOCD", name: "瞬间释放", desc: "同时按两键时按预设快速触发" },
  { kind: 5, tag: "MPT", name: "多点触控", desc: "一次按键触发三次不同输入" },
  { kind: 6, tag: "END", name: "终端跃迁", desc: "松开时触发另一个按键" },
  { kind: 7, tag: "RS", name: "迅捷", desc: "同时按两键时触发按得更深的那个" },
];

const MAX_GROUPS: Record<number, number> = { 3: 4, 5: 3 };

const hex8 = (n: number): string => `0x${toHex(n >>> 0, 8)}`;
const keyLabel = (id: number): string =>
  `${layout68.find((k) => k.keyValue === id)?.name ?? "?"} (${id})`;
const mmOf = (v100: number): string => `${(v100 / 100).toFixed(2)}mm`;

function cloneKey(k: AdvancedKey): AdvancedKey {
  return {
    ...k,
    ids: [...k.ids],
    depths: [...k.depths],
    groups: k.groups.map((g) => ({
      ...g,
      triggers: g.triggers ? [...g.triggers] : g.triggers,
    })),
  };
}

function defaultDraft(kind: number, id: number): AdvancedKey {
  return {
    kind,
    id,
    ids: kind === 7 ? [layout68[0].keyValue, layout68[1].keyValue] : [],
    keycode: 0,
    hold_keycode: 0,
    click_keycode: 0,
    delay: 200,
    depths: [0, 0, 0, 0],
    groups:
      kind === 3
        ? [{ keycode: 0, triggers: [0, 0, 0, 0] }]
        : kind === 5
          ? [{ keycode: 0, distance: 0 }]
          : [],
    response_mode: 0,
  };
}

function summarize(k: AdvancedKey): string {
  switch (k.kind) {
    case 1:
      return `键码 ${keycodeName(k.keycode)} · 延时 ${k.delay}ms`;
    case 2:
      return `按住 ${keycodeName(k.hold_keycode)} · 单击 ${keycodeName(k.click_keycode)} · 延时 ${k.delay}ms`;
    case 3:
      return `深度 ${[0, 1, 2, 3].map((i) => mmOf(k.depths[i] ?? 0)).join(" / ")} · ${k.groups.length} 组`;
    case 4:
      return `关联 ${k.ids.map(keyLabel).join(" + ")} · 模式 ${k.response_mode}`;
    case 5:
      return k.groups
        .map((g) => `${keycodeName(g.keycode)} @ ${mmOf(g.distance ?? 0)}`)
        .join(" · ");
    case 6:
      return `松开触发 ${keycodeName(k.keycode)}`;
    case 7:
      return `组合 ${k.ids.map(keyLabel).join(" + ")}`;
    default:
      return "";
  }
}

function validate(k: AdvancedKey): string | null {
  if (k.kind === 3 && (k.groups.length < 1 || k.groups.length > 4))
    return "动态键程 (DKS) 需要 1~4 组功能";
  if (k.kind === 4 && k.ids.length < 1) return "瞬间释放 (SOCD) 至少需要一个关联键";
  if (k.kind === 5 && (k.groups.length < 1 || k.groups.length > 3))
    return "多点触控 (MPT) 需要 1~3 组功能";
  if (k.kind === 7 && k.ids.length !== 2) return "迅捷 (RS) 必须恰好选择 2 个键";
  return null;
}

function keySelect(current: number, onPick: (v: number) => void): HTMLElement {
  const sel = el("select", { style: "min-width:200px" });
  for (const k of layout68) {
    const opt = el("option", {
      value: String(k.keyValue),
      text: `${k.name} (id ${k.keyValue})`,
    });
    if (k.keyValue === current) opt.selected = true;
    sel.append(opt);
  }
  sel.onchange = () => onPick(Number(sel.value));
  return sel;
}

const KC_OPTIONS = keycodes.filter((k) => k.value <= 0xffffffff);

function kcPicker(current: number, onPick: (v: number) => void): HTMLElement {
  const sel = el("select", { style: "min-width:280px" });
  const known = KC_OPTIONS.some((k) => k.value === current);
  sel.append(
    el("option", {
      value: "",
      text: known ? "选择键码…" : `自定义 ${hex8(current)}`,
    }),
  );
  for (const k of KC_OPTIONS) {
    const opt = el("option", {
      value: String(k.value),
      text: `${k.name} (${hex8(k.value)})`,
    });
    if (k.value === current) opt.selected = true;
    sel.append(opt);
  }
  const hx = el("input", {
    class: "mono",
    style: "width:110px",
    value: hex8(current),
    title: "十六进制键码，可手输",
  });
  const name = el("span", { class: "block-label", style: "margin:0", text: keycodeName(current) });
  sel.onchange = () => {
    if (sel.value !== "") onPick(Number(sel.value));
  };
  hx.onchange = () => {
    const v = Number.parseInt(hx.value.trim().replace(/^0x/i, ""), 16);
    if (Number.isFinite(v) && v >= 0 && v <= 0xffffffff) onPick(v >>> 0);
    else {
      toast("键码 hex 无效", true);
      hx.value = hex8(current);
    }
  };
  return el("div", { class: "row", style: "gap:8px;margin-bottom:8px" }, sel, hx, name);
}

function numField(label: string, value: number, attrs: Record<string, string>, onChange: (n: number) => void): HTMLElement {
  const inp = el("input", { type: "number", value: String(value), ...attrs });
  inp.onchange = () => {
    const v = Number(inp.value);
    if (Number.isFinite(v)) onChange(v);
  };
  return el("label", { class: "field", style: "min-width:120px" }, label, inp);
}

// UI 毫米值，内部以 0.01mm 存储（×100 后与固件一致）。
function mmInput(v100: number, onChange: (v: number) => void): HTMLElement {
  const inp = el("input", {
    type: "number",
    value: (v100 / 100).toFixed(2),
    min: "0",
    step: "0.05",
    style: "width:90px",
    title: "毫米，内部 ×100 存储",
  });
  inp.onchange = () => {
    const v = Number(inp.value);
    if (Number.isFinite(v) && v >= 0) onChange(Math.round(v * 100));
    else inp.value = (v100 / 100).toFixed(2);
  };
  return inp;
}

function byteInput(value: number, onChange: (n: number) => void): HTMLElement {
  const inp = el("input", {
    type: "number",
    min: "0",
    max: "255",
    placeholder: "0",
    style: "width:64px",
    title: "0-255，留空 = 0",
    value: value === 0 ? "" : String(value),
  });
  inp.onchange = () => {
    const n = inp.value.trim() === "" ? 0 : Number(inp.value);
    if (Number.isInteger(n) && n >= 0 && n <= 255) onChange(n);
    else {
      toast("触发段需为 0-255", true);
      inp.value = value === 0 ? "" : String(value);
    }
  };
  return inp;
}

export async function renderAdvanced(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "高级键" }),
    el("p", {
      class: "sub",
      text: "七种高级触发功能（官方驱动线格式）。写入采用先删后写，写后读回；编码 hex 仅供排错。",
    }),
  );

  let layer = 0;
  let entries: AdvancedEntry[] = [];
  let draft: AdvancedKey | null = null;
  let editEntryId: number | null = null;

  const tabs = el("div", { class: "layers" });
  const listCard = el("div", { class: "card" });
  const formCard = el("div", { class: "card" });
  page.append(tabs, listCard, formCard);

  function renderTabs(): void {
    tabs.replaceChildren();
    for (const l of LAYERS) {
      const b = el("button", {
        class: `btn${l.layer === layer ? " primary" : ""}`,
        text: l.label,
      });
      b.onclick = () => {
        layer = l.layer;
        draft = null;
        editEntryId = null;
        void load();
      };
      tabs.append(b);
    }
  }

  function renderList(): void {
    renderTabs();
    const head = el("h2", { text: "已配置" });
    const newBtn = el("button", {
      class: "btn primary",
      text: "新建高级键",
      style: "float:right;margin-top:-4px",
    });
    newBtn.onclick = () => {
      draft = defaultDraft(1, layout68[0].keyValue);
      editEntryId = null;
      renderForm();
      formCard.scrollIntoView({ behavior: "smooth" });
    };
    head.append(newBtn);

    if (entries.length === 0) {
      listCard.replaceChildren(head, el("div", { class: "empty", text: "本层没有高级键槽位。" }));
      return;
    }

    const tbody = el("tbody");
    const jobs: Promise<unknown>[] = [];
    for (const e of entries) {
      const tr = el("tr");
      if (e.key === null) {
        tr.append(
          el("td", { text: `id ${e.id}` }),
          el("td", { text: "空槽" }),
          el("td", { text: "—" }),
          el("td", { text: "—" }),
        );
        const ops = el("td");
        const edit = el("button", { class: "btn", text: "编辑" });
        edit.onclick = () => {
          draft = defaultDraft(1, e.id);
          editEntryId = null;
          renderForm();
        };
        ops.append(edit);
        tr.append(ops);
      } else {
        const k = e.key;
        const hexCell = el("td", { class: "mono", text: "…" });
        jobs.push(
          api
            .previewAdvanced(k)
            .then((h) => {
              hexCell.textContent = h;
            })
            .catch((err: unknown) => {
              hexCell.textContent = `预览失败: ${err}`;
            }),
        );
        const edit = el("button", { class: "btn", text: "编辑" });
        edit.onclick = () => {
          draft = cloneKey(k);
          editEntryId = e.id;
          renderForm();
          formCard.scrollIntoView({ behavior: "smooth" });
        };
        const del = el("button", { class: "btn danger", text: "删除" });
        del.onclick = () => {
          void (async () => {
            if (!confirm(`删除 ${keyLabel(k.id)} 的 ${KINDS[k.kind - 1].name} 配置？`)) return;
            try {
              await api.deleteAdvancedKey2(layer, 0, k.id);
              toast(`已删除 id ${k.id}`);
              await load();
            } catch (err) {
              toast(`删除失败: ${err}`, true);
            }
          })();
        };
        tr.append(
          el("td", { text: keyLabel(k.id) }),
          el("td", { text: `${KINDS[k.kind - 1].name} (${KINDS[k.kind - 1].tag})` }),
          el("td", { text: summarize(k) }),
          hexCell,
          el("td", {}, edit, " ", del),
        );
      }
      tbody.append(tr);
    }
    void Promise.all(jobs);

    listCard.replaceChildren(
      head,
      el(
        "table",
        { class: "kv-table" },
        el(
          "thead",
          {},
          el("tr", {}, el("th", { text: "键" }), el("th", { text: "类型" }), el("th", { text: "参数" }), el("th", { text: "编码 hex" }), el("th", { text: "操作" })),
        ),
        tbody,
      ),
    );
  }

  function idsEditor(ids: number[], fixedCount: boolean, onChange: (ids: number[]) => void): HTMLElement {
    const wrap = el("div");
    ids.forEach((id, i) => {
      const row = el(
        "div",
        { class: "row", style: "margin-bottom:6px" },
        keySelect(id, (v) => {
          const next = [...ids];
          next[i] = v;
          onChange(next);
        }),
      );
      if (!fixedCount) {
        const rm = el("button", { class: "btn danger", text: "删除" });
        rm.onclick = () => onChange(ids.filter((_, j) => j !== i));
        row.append(rm);
      }
      wrap.append(row);
    });
    if (!fixedCount) {
      const add = el("button", { class: "btn", text: "+ 添加键" });
      add.onclick = () => onChange([...ids, layout68[0].keyValue]);
      wrap.append(add);
    }
    return wrap;
  }

  function groupsEditor(kind: number, groups: AdvancedGroup[], onChange: (g: AdvancedGroup[]) => void): HTMLElement {
    const max = MAX_GROUPS[kind] ?? 0;
    const wrap = el("div");
    groups.forEach((g, i) => {
      const set = (patch: Partial<AdvancedGroup>) => {
        const next = groups.map((x) => ({ ...x }));
        next[i] = { ...next[i], ...patch };
        onChange(next);
      };
      const row = el("div", { class: "row", style: "margin-bottom:6px;align-items:center" });
      row.append(
        kcPicker(g.keycode, (v) => set({ keycode: v })),
        kind === 5
          ? el("label", { class: "field", style: "flex-direction:row;align-items:center;gap:6px" }, "距离 mm ", mmInput(g.distance ?? 0, (v) => set({ distance: v })))
          : el(
              "div",
              { class: "row", style: "gap:6px;align-items:center" },
              el("span", { class: "block-label", style: "margin:0", text: "触发段" }),
              ...[0, 1, 2, 3].map((j) =>
                byteInput(g.triggers?.[j] ?? 0, (n) => {
                  const tr = [0, 1, 2, 3].map((x) => g.triggers?.[x] ?? 0);
                  tr[j] = n;
                  set({ triggers: tr });
                }),
              ),
            ),
      );
      const rm = el("button", { class: "btn danger", text: "删除" });
      rm.onclick = () => onChange(groups.filter((_, j) => j !== i));
      row.append(rm);
      wrap.append(row);
    });
    const add = el("button", { class: "btn", text: `+ 添加功能 (${groups.length}/${max})` });
    add.disabled = groups.length >= max;
    add.onclick = () =>
      onChange([
        ...groups,
        kind === 3 ? { keycode: 0, triggers: [0, 0, 0, 0] } : { keycode: 0, distance: 0 },
      ]);
    wrap.append(add);
    if (kind === 3) {
      wrap.append(
        el("p", {
          class: "sub",
          style: "margin:8px 0 0",
          text: "触发段为固件内部枚举，官方未公开语义，随意填写可能无效；留空 = 0。",
        }),
      );
    }
    return wrap;
  }

  function renderForm(): void {
    if (draft === null) {
      formCard.replaceChildren(
        el("h2", { text: "新建 / 编辑" }),
        el("div", { class: "empty", text: "点击「新建高级键」或列表中的「编辑」开始配置。" }),
      );
      return;
    }
    const d = draft;
    const info = KINDS[d.kind - 1];

    const head = el(
      "h2",
      {},
      `${editEntryId === null ? "新建" : `编辑 (槽位 id ${editEntryId})`} — ${info.name} (${info.tag})`,
      el("span", { class: "hint", text: info.desc }),
    );

    const kindGrid = el("div", { class: "modes" });
    for (const k of KINDS) {
      const b = el("button", {
        class: `btn mode${d.kind === k.kind ? " primary" : ""}`,
        text: `${k.name} ${k.tag}`,
        title: k.desc,
      });
      b.onclick = () => {
        draft = { ...defaultDraft(k.kind, d.id) };
        renderForm();
      };
      kindGrid.append(b);
    }

    const body = el("div", {}, el("div", { class: "block-label", text: "类型" }), kindGrid);

    body.append(
      el("div", { class: "block-label", text: "承载键（该功能绑定的物理键）" }),
      el("div", { class: "row", style: "margin-bottom:8px" }, keySelect(d.id, (v) => {
        d.id = v;
      })),
    );

    if (d.kind === 1 || d.kind === 6) {
      body.append(
        el("div", { class: "block-label", text: "触发键码" }),
        kcPicker(d.keycode, (v) => {
          d.keycode = v;
          renderForm();
        }),
        d.kind === 1
          ? el("div", { class: "row" }, numField("延时 (ms)", d.delay, { min: "0", step: "10" }, (v) => {
              d.delay = v;
            }))
          : el("p", { class: "sub", text: "松开承载键时触发上述键码。" }),
      );
    } else if (d.kind === 2) {
      body.append(
        el("div", { class: "block-label", text: "长按时触发" }),
        kcPicker(d.hold_keycode, (v) => {
          d.hold_keycode = v;
          renderForm();
        }),
        el("div", { class: "block-label", text: "单击时触发" }),
        kcPicker(d.click_keycode, (v) => {
          d.click_keycode = v;
          renderForm();
        }),
        el("div", { class: "row" }, numField("判定延时 (ms)", d.delay, { min: "0", step: "10" }, (v) => {
          d.delay = v;
        })),
      );
    } else if (d.kind === 3) {
      body.append(
        el("div", { class: "block-label", text: "触发深度（4 段，毫米）" }),
        el(
          "div",
          { class: "row", style: "margin-bottom:8px" },
          ...[0, 1, 2, 3].map((i) =>
            el("label", { class: "field", style: "flex-direction:row;align-items:center;gap:6px" }, `段${i + 1} `, mmInput(d.depths[i] ?? 0, (v) => {
              while (d.depths.length < 4) d.depths.push(0);
              d.depths[i] = v;
            })),
          ),
        ),
        el("div", { class: "block-label", text: `功能组（${d.groups.length}/4）` }),
        groupsEditor(3, d.groups, (g) => {
          d.groups = g;
          renderForm();
        }),
      );
    } else if (d.kind === 4) {
      body.append(
        el("div", { class: "block-label", text: "关联键（与承载键同按时按预设触发）" }),
        idsEditor(d.ids, false, (ids) => {
          d.ids = ids;
          renderForm();
        }),
        el("div", { class: "row" }, numField("响应模式", d.response_mode, { min: "0", max: "255", step: "1" }, (v) => {
          d.response_mode = v;
        })),
        el("p", { class: "sub", text: "响应模式 0 = 默认。" }),
      );
    } else if (d.kind === 5) {
      body.append(
        el("div", { class: "block-label", text: `功能组（${d.groups.length}/3），按按压距离依次触发` }),
        groupsEditor(5, d.groups, (g) => {
          d.groups = g;
          renderForm();
        }),
      );
    } else if (d.kind === 7) {
      body.append(
        el("div", { class: "block-label", text: "关联键（恰好 2 个，取按得更深的触发）" }),
        idsEditor(d.ids, true, (ids) => {
          d.ids = ids;
        }),
      );
    }

    const preview = el("div", { class: "mono", style: "word-break:break-all", text: "…" });
    void api
      .previewAdvanced(d)
      .then((h) => {
        preview.textContent = h;
      })
      .catch((err: unknown) => {
        preview.textContent = `预览失败: ${err}`;
      });
    body.append(
      el("div", { class: "block-label", text: "编码预览（不写设备，仅供排错）" }),
      preview,
    );

    const save = el("button", { class: "btn primary", text: "写入 (先删后写)" });
    save.onclick = () => {
      void (async () => {
        if (!draft) return;
        const err = validate(draft);
        if (err) {
          toast(err, true);
          return;
        }
        save.disabled = true;
        try {
          const key: AdvancedKey = {
            ...draft,
            ids: [...draft.ids],
            depths:
              draft.kind === 3
                ? [0, 1, 2, 3].map((i) => draft!.depths[i] ?? 0)
                : [...draft.depths],
            groups: draft.groups.map((g) => ({
              keycode: g.keycode,
              distance: g.distance ?? null,
              triggers: g.triggers
                ? [0, 1, 2, 3].map((i) => g.triggers![i] ?? 0)
                : g.triggers,
            })),
          };
          await api.deleteAdvancedKey2(layer, 0, key.id);
          await api.setAdvancedKey(layer, 0, key);
          toast(`已写入 ${KINDS[key.kind - 1].name} → ${keyLabel(key.id)}`);
          draft = null;
          editEntryId = null;
          await load();
        } catch (e) {
          toast(`写入失败: ${e}`, true);
        } finally {
          save.disabled = false;
        }
      })();
    };
    const cancel = el("button", { class: "btn", text: "取消" });
    cancel.onclick = () => {
      draft = null;
      editEntryId = null;
      renderForm();
    };
    body.append(el("div", { class: "row", style: "margin-top:16px" }, save, cancel));

    formCard.replaceChildren(head, body);
  }

  async function load(): Promise<void> {
    listCard.replaceChildren(
      el("h2", { text: "已配置" }),
      el("div", { class: "empty", text: "读取中…" }),
    );
    try {
      entries = await api.readAdvanced(layer, 0);
    } catch (e) {
      entries = [];
      listCard.replaceChildren(
        el("h2", { text: "已配置" }),
        el("div", { class: "empty", text: `读取失败: ${e}` }),
      );
      renderTabs();
      return;
    }
    renderList();
    renderForm();
  }

  await load();
}
