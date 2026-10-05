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
