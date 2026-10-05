import { api, toHex, type DeviceDesc } from "../api";
import { el } from "../ui";

export async function renderDevices(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "设备" }),
    el("p", {
      class: "sub",
      text: "枚举 AULA 配置接口（usage_page 0xFF60 / usage 0x61）。WebHID 与本程序可同时打开同一接口。",
    }),
  );

  const listCard = el("div", { class: "card" }, el("h2", { text: "配置接口列表" }));
  const listBody = el("div", {});
  listCard.append(listBody);
  page.append(listCard);

  async function refresh(): Promise<void> {
    listBody.replaceChildren(el("div", { class: "empty", text: "枚举中…" }));
    let devs: DeviceDesc[];
    try {
      devs = await api.listDevices();
    } catch (e) {
      listBody.replaceChildren(
        el("div", { class: "empty", text: `枚举失败: ${e}` }),
      );
      return;
    }
    if (devs.length === 0) {
      listBody.replaceChildren(
        el("div", {
          class: "empty",
          text: "未发现设备。请确认键盘已连接（有线或 8K 接收器）。",
        }),
      );
      return;
    }
    listBody.replaceChildren();
    for (const d of devs) {
      const openBtn = el("button", { class: "btn primary", text: "打开" });
      openBtn.onclick = async () => {
        openBtn.disabled = true;
        try {
          await api.openDevice(d.path);
          window.dispatchEvent(new CustomEvent("aula:connected"));
        } catch (e) {
          alert(`打开失败: ${e}`);
        } finally {
          openBtn.disabled = false;
        }
      };
      const title = el(
        "span",
        { class: "name" },
        d.product ?? "AULA 设备",
        d.framed
          ? el("span", { class: "badge wireless", text: "8K 无线 · 分帧" })
          : el("span", { class: "badge", text: "整包直发" }),
      );
      listBody.append(
        el(
          "div",
          { class: "dev-item" },
          el(
            "div",
            { class: "meta" },
            title,
            el(
              "span",
              {
                class: "ids",
                text: `VID 0x${toHex(d.vendor_id, 4)} · PID 0x${toHex(d.product_id, 4)} · usage_page 0x${toHex(d.usage_page, 4)} · usage 0x${toHex(d.usage)}`,
              },
            ),
          ),
          openBtn,
        ),
      );
    }
  }

  const bar = el(
    "div",
    { class: "row" },
    el("button", { class: "btn", text: "重新枚举" }),
  );
  (bar.firstChild as HTMLButtonElement).onclick = () => void refresh();
  listCard.append(bar);
  await refresh();
}
