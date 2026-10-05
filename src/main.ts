import "./style.css";
import { api } from "./api";
import { el } from "./ui";
import { renderDevices } from "./pages/devices";
import { renderStatus } from "./pages/status";
import { renderKeymap } from "./pages/keymap";
import { renderProfiles } from "./pages/profiles";
import { renderDebug } from "./pages/debug";

const PAGES = [
  { id: "devices", label: "设备", render: renderDevices, needsDevice: false },
  { id: "status", label: "设备信息", render: renderStatus, needsDevice: true },
  { id: "keymap", label: "改键", render: renderKeymap, needsDevice: true },
  { id: "profiles", label: "板载配置", render: renderProfiles, needsDevice: true },
  { id: "debug", label: "原始命令", render: renderDebug, needsDevice: true },
];

let connected = false;
let activeId = "devices";

async function refreshConnPill(pill: HTMLElement): Promise<void> {
  pill.classList.toggle("on", connected);
  pill.querySelector("span:last-child")!.textContent = connected
    ? "设备已连接"
    : "未连接设备";
}

async function renderActive(main: HTMLElement): Promise<void> {
  const page = main.querySelector<HTMLElement>(`.page[data-id="${activeId}"]`)!;
  main.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  page.classList.add("active");
  const def = PAGES.find((p) => p.id === activeId)!;
  if (def.needsDevice && !connected) {
    page.replaceChildren(
      el("h1", { text: def.label }),
      el("div", { class: "empty", text: "请先在「设备」页打开一个设备。" }),
    );
    return;
  }
  await def.render(page);
}

async function main(): Promise<void> {
  const nav = el("nav", { class: "sidebar" });
  const brand = el(
    "div",
    { class: "brand" },
    el("span", { class: "logo" }, "AULA", el("em", { text: "drv" })),
    el("span", { class: "tag", text: "unofficial" }),
  );
  const pill = el(
    "div",
    { class: "conn-pill" },
    el("span", {}, el("i", { class: "dot" }), el("span", { text: "未连接设备" })),
    el("button", { class: "btn", text: "断开" }),
  );
  (pill.querySelector("button") as HTMLButtonElement).onclick = async () => {
    try {
      await api.closeDevice();
    } finally {
      connected = false;
      await refreshConnPill(pill);
      await renderActive(mainEl);
    }
  };
  nav.append(brand);

  const mainEl = el("main", { class: "main" });
  for (const p of PAGES) {
    const btn = el("button", {
      class: `nav-btn${p.id === activeId ? " active" : ""}`,
      text: p.label,
    });
    btn.onclick = async () => {
      activeId = p.id;
      nav.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      await renderActive(mainEl);
    };
    nav.append(btn);
    mainEl.append(el("section", { class: "page", "data-id": p.id }));
  }
  nav.append(pill);

  const app = document.getElementById("app")!;
  app.append(nav, mainEl);

  window.addEventListener("aula:connected", async () => {
    connected = true;
    await refreshConnPill(pill);
    await renderActive(mainEl);
  });

  await renderActive(mainEl);
}

void main();
