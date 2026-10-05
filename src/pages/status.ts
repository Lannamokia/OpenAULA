import { api, toHex } from "../api";
import { el } from "../ui";

export async function renderStatus(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "设备信息" }),
    el("p", { class: "sub", text: "电量 / UUID / 固件版本 / 当前板载配置（只读）。" }),
    el("div", { class: "card" }, el("h2", { text: "状态" }), el("div", { class: "empty", text: "读取中…" })),
  );
  const card = page.querySelector(".card")!;
  let s;
  try {
    s = await api.deviceStatus();
  } catch (e) {
    card.replaceChildren(
      el("h2", { text: "状态" }),
      el("div", { class: "empty", text: `读取失败: ${e}` }),
    );
    return;
  }

  const stat = (k: string, v: string) =>
    el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: v }));

  const battery = s.battery
    ? `${s.battery.level}%${s.battery.charging ? " · 充电中" : ""}`
    : "—";
  const grid = el(
    "div",
    { class: "grid" },
    stat("设备", s.product ?? "—"),
    stat("链路", s.framed ? "8K 无线 (0x66 分帧)" : "有线 / 整包直发"),
    stat("VID:PID", `0x${toHex(s.vendor_id, 4)}:0x${toHex(s.product_id, 4)}`),
    stat("固件版本", s.firmware ?? "—"),
    stat("电量", battery),
    stat("UUID", s.uuid ?? "—"),
    stat("当前板载配置", s.profile !== null ? `#${s.profile + 1}` : "—"),
  );
  card.replaceChildren(el("h2", { text: "状态" }), grid);

  const reload = el("button", { class: "btn", text: "刷新" });
  reload.onclick = () => void renderStatus(page);
  card.append(el("div", { style: "margin-top:14px" }, reload));
}
