import { api, toHex, type DeviceDesc } from "../api";
import { beginLoading, el, toast } from "../ui";

/**
 * 最近一次打开的设备。放在模块级是因为 `aula:connected` 会触发整页重渲染，
 * 局部的 DOM 状态留不住；休眠提醒必须在重渲染后仍然显示。
 */
let session: { desc: DeviceDesc; awake: boolean } | null = null;

/** 断开设备时清掉会话（main.ts 的「断开」按钮调用）。 */
export function clearDeviceSession(): void {
  session = null;
}

export async function renderDevices(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "设备" }),
    el("p", {
      class: "sub",
      text: "列出键盘的配置接口，选择后打开连接。",
    }),
  );

  const sessionHost = el("div", {});
  page.append(sessionHost);

  /** 画（或重画）当前连接状态卡片；未连接时该区域为空。 */
  function renderSession(): void {
    const s = session;
    if (!s) {
      sessionHost.replaceChildren();
      return;
    }
    const d = s.desc;
    const title = el(
      "span",
      { class: "name" },
      d.product ?? "AULA 设备",
      d.framed
        ? el("span", { class: "badge wireless", text: "8K 无线" })
        : el("span", { class: "badge", text: "有线" }),
    );
    const recheck = el("button", { class: "btn primary", text: "重新检测" });
    recheck.onclick = async () => {
      recheck.disabled = true;
      const task = beginLoading("正在重新检测设备…");
      try {
        const res = await api.openDevice(d.path);
        session = { desc: res.device, awake: res.awake };
        renderSession();
        if (res.awake) toast("设备已响应，可以开始设置了");
      } catch (e) {
        toast(`检测失败: ${e}`, true);
      } finally {
        task.done();
      }
    };

    if (s.awake) {
      sessionHost.replaceChildren(
        el(
          "div",
          { class: "card" },
          el("h2", {}, "当前连接", el("span", { class: "hint", text: "设备已响应" })),
          el(
            "div",
            { class: "grid" },
            el(
              "div",
              { class: "stat" },
              el("div", { class: "k", text: "设备" }),
              el("div", { class: "v", text: d.product ?? "AULA 设备" }),
            ),
            el(
              "div",
              { class: "stat" },
              el("div", { class: "k", text: "标识" }),
              el(
                "div",
                { class: "v" },
                `0x${toHex(d.vendor_id, 4)}:0x${toHex(d.product_id, 4)}`,
              ),
            ),
          ),
        ),
      );
      return;
    }

    sessionHost.replaceChildren(
      el(
        "div",
        { class: "card notice" },
        el("h2", {}, "设备可能处于休眠状态", el("span", { class: "hint", text: "未响应" })),
        el("p", {
          class: "notice-body",
          text: "已经连上键盘，但键盘没有回应。使用无线接收器时，键盘闲置一会儿会自动休眠。",
        }),
        el("p", {
          class: "notice-body strong",
          text: "请按一下键盘上的任意键唤醒它，然后点「重新检测」。",
        }),
        el(
          "div",
          { class: "row", style: "margin-top:12px" },
          recheck,
          el(
            "span",
            { class: "hint" },
            title,
            el("span", {
              class: "ids",
              style: "display:block;margin-top:4px",
              text: `VID 0x${toHex(d.vendor_id, 4)} · PID 0x${toHex(d.product_id, 4)}`,
            }),
          ),
        ),
      ),
    );
  }

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
        const task = beginLoading("正在连接设备…");
        try {
          const res = await api.openDevice(d.path);
          session = { desc: res.device, awake: res.awake };
          window.dispatchEvent(
            new CustomEvent("aula:connected", { detail: { awake: res.awake } }),
          );
        } catch (e) {
          alert(`打开失败: ${e}`);
        } finally {
          task.done();
          openBtn.disabled = false;
        }
      };
      const title = el(
        "span",
        { class: "name" },
        d.product ?? "AULA 设备",
        d.framed
          ? el("span", { class: "badge wireless", text: "8K 无线" })
          : el("span", { class: "badge", text: "有线" }),
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
                text: `VID 0x${toHex(d.vendor_id, 4)} · PID 0x${toHex(d.product_id, 4)}`,
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
  renderSession();
  await refresh();
}
