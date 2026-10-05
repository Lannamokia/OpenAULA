import { api, toHex } from "../api";
import { el } from "../ui";

export async function renderDebug(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "原始命令" }),
    el("p", {
      class: "sub",
      text: "直接向设备发送一条应用包（cmd / param / data hex），显示请求与应答。谨慎使用写命令。",
    }),
  );

  const card = el("div", { class: "card" }, el("h2", { text: "发送" }));
  const cmdIn = el("input", { type: "text", value: "87", style: "width:70px" });
  const paramIn = el("input", { type: "text", value: "00", style: "width:70px" });
  const dataIn = el("input", {
    type: "text",
    placeholder: "data hex，可空",
    style: "width:320px",
  });
  const log = el("div", { class: "log" });
  log.textContent = "// request / response 将显示在这里";

  const send = el("button", { class: "btn primary", text: "发送" });
  send.onclick = async () => {
    send.disabled = true;
    try {
      const cmd = parseInt(cmdIn.value, 16);
      const param = parseInt(paramIn.value, 16);
      const r = await api.rawExchange(cmd, param, dataIn.value.trim());
      const prev = log.textContent === "// request / response 将显示在这里" ? "" : log.textContent + "\n";
      log.textContent =
        `${prev}> 0x${toHex(cmd)} 0x${toHex(param)} ${dataIn.value.trim() || "(no data)"}\n` +
        `  tx: ${r.request}\n` +
        `  rx: ${r.response ?? "(timeout)"}`;
    } catch (e) {
      log.textContent += `\nerror: ${e}`;
    } finally {
      send.disabled = false;
    }
  };

  card.append(
    el(
      "div",
      { class: "row" },
      el("label", { class: "field" }, "cmd (hex)", cmdIn),
      el("label", { class: "field" }, "param (hex)", paramIn),
      el("label", { class: "field" }, "data (hex)", dataIn),
      send,
    ),
    el("div", { style: "margin-top:14px" }, log),
  );
  page.append(card);
}
