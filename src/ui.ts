/** Tiny DOM helpers. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

let toastTimer = 0;

export function toast(msg: string, isErr = false): void {
  let t = document.querySelector<HTMLElement>(".toast");
  if (!t) {
    t = el("div", { class: "toast" });
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 3200);
}

// --- 非阻塞加载指示器 ---------------------------------------------------------
//
// 无线链路下一次命令就是一个完整的往返（几十毫秒起），读一页往往是好几条命令。
// 这里刻意**不做模态遮罩**：卡片浮在顶部、`pointer-events: none`，页面其余部分
// 照常可用。后来者压在上面（内层 `load()` 会盖住外层的文字），它结束时外层
// 的状态自动回到台面上，所以嵌套调用不需要调用方自己配对。

interface LoadingEntry {
  text: string;
  /** null = 不确定进度（转圈）；0..1 = 确定进度（进度条）。 */
  progress: number | null;
}

const loadingStack: LoadingEntry[] = [];
let loadingCard: HTMLElement | null = null;
let loadingTextEl: HTMLElement | null = null;
let loadingFillEl: HTMLElement | null = null;
let loadingPctEl: HTMLElement | null = null;

function buildLoadingCard(): void {
  loadingTextEl = el("span", { class: "loading-text" });
  loadingPctEl = el("span", { class: "loading-pct" });
  loadingFillEl = el("div", { class: "loading-bar-fill" });
  loadingCard = el(
    "div",
    { class: "loading-card" },
    el("div", { class: "loading-row" }, el("span", { class: "spin" }), loadingTextEl, loadingPctEl),
    el("div", { class: "loading-bar" }, loadingFillEl),
  );
  document.body.append(loadingCard);
}

function paintLoading(): void {
  const top = loadingStack[loadingStack.length - 1];
  if (!top) {
    loadingCard?.remove();
    loadingCard = null;
    loadingTextEl = null;
    loadingFillEl = null;
    loadingPctEl = null;
    return;
  }
  loadingTextEl!.textContent = top.text;
  if (top.progress === null) {
    loadingCard!.classList.remove("determinate");
    loadingPctEl!.textContent = "";
    return;
  }
  const p = Math.max(0, Math.min(1, top.progress));
  loadingCard!.classList.add("determinate");
  loadingFillEl!.style.width = `${(p * 100).toFixed(1)}%`;
  loadingPctEl!.textContent = `${Math.round(p * 100)}%`;
}

/** 开始一次可能较慢的操作。返回的句柄用来更新文字/进度并结束它。 */
export function beginLoading(text: string): {
  setText(s: string): void;
  /** null = 不确定进度（转圈）；0..1 = 确定进度（进度条） */
  setProgress(p: number | null): void;
  done(): void;
} {
  const entry: LoadingEntry = { text, progress: null };
  loadingStack.push(entry);
  if (!loadingCard) buildLoadingCard();
  paintLoading();
  const isTop = (): boolean => loadingStack[loadingStack.length - 1] === entry;
  let finished = false;
  return {
    setText(s: string): void {
      if (finished) return;
      entry.text = s;
      if (isTop()) paintLoading();
    },
    setProgress(p: number | null): void {
      if (finished) return;
      entry.progress = p;
      if (isTop()) paintLoading();
    },
    done(): void {
      if (finished) return;
      finished = true;
      const i = loadingStack.indexOf(entry);
      if (i >= 0) loadingStack.splice(i, 1);
      paintLoading();
    },
  };
}
