import "./style.css";
import { api } from "./api";
import { el } from "./ui";
import { clearDeviceSession, renderDevices } from "./pages/devices";
import { renderStatus } from "./pages/status";
import { renderKeymap } from "./pages/keymap";
import { renderAdvanced } from "./pages/advanced";
import { renderTrigger } from "./pages/trigger";
import { renderMacros } from "./pages/macros";
import { renderLighting } from "./pages/lighting";
import { renderProfiles } from "./pages/profiles";
import { renderMusic } from "./pages/music";
import { renderSettings } from "./pages/settings";
import { renderDebug } from "./pages/debug";

const PAGES = [
  { id: "devices", label: "设备", render: renderDevices, needsDevice: false },
  { id: "status", label: "设备信息", render: renderStatus, needsDevice: true },
  { id: "keymap", label: "改键", render: renderKeymap, needsDevice: true },
  { id: "advanced", label: "高级键", render: renderAdvanced, needsDevice: true },
  { id: "trigger", label: "触发设置", render: renderTrigger, needsDevice: true },
  { id: "macros", label: "宏", render: renderMacros, needsDevice: true },
  { id: "lighting", label: "灯光", render: renderLighting, needsDevice: true },
  { id: "music", label: "神光同步", render: renderMusic, needsDevice: true },
  { id: "profiles", label: "板载配置", render: renderProfiles, needsDevice: true },
  { id: "settings", label: "系统设置", render: renderSettings, needsDevice: true },
  { id: "debug", label: "原始命令", render: renderDebug, needsDevice: true },
];

let connected = false;
/** 连接探测是否得到应答；无线下 false 基本等于键盘睡着了。 */
let awake = true;
let activeId = "devices";

/** 离开页面时的收尾：设备上的行程监测流/校准轮询必须停掉，否则会一直往主机推数据。 */
async function leavePage(id: string): Promise<void> {
  if (id !== "trigger") return;
  try {
    await api.stopTravelMonitor();
  } catch {
    /* 设备没开也正常 */
  }
  try {
    await api.stopCalibration();
  } catch {
    /* 同上 */
  }
}

async function refreshConnPill(pill: HTMLElement): Promise<void> {
  const sleeping = connected && !awake;
  pill.classList.toggle("on", connected);
  pill.querySelector(".dot")!.classList.toggle("warn", sleeping);
  pill.querySelector("span:last-child")!.textContent = !connected
    ? "未连接设备"
    : sleeping
      ? "设备已连接（可能休眠）"
      : "设备已连接";
}

async function renderActive(main: HTMLElement): Promise<void> {  const page = main.querySelector<HTMLElement>(`.page[data-id="${activeId}"]`)!;
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
    el("span", { class: "logo" }, "Open", el("em", { text: "AULA" })),
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
      awake = true;
      clearDeviceSession();
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
      if (activeId !== p.id) await leavePage(activeId);
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

  window.addEventListener("aula:connected", async (ev: Event) => {
    connected = true;
    awake = (ev as CustomEvent<{ awake?: boolean }>).detail?.awake ?? true;
    await refreshConnPill(pill);
    await renderActive(mainEl);
  });

  await renderActive(mainEl);
}

void main();
