import { api } from "../api";
import { el } from "../ui";

export async function renderProfiles(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "板载配置" }),
    el("p", {
      class: "sub",
      text: "0x90 读当前配置 / 0x10 切换（配置号在 data 字节）。本机共 3 个配置 (0..2)。",
    }),
  );
  const card = el("div", { class: "card" }, el("h2", { text: "切换" }));
  const info = el("div", { class: "stat", style: "max-width:260px" });
  page.append(card);

  async function refresh(): Promise<void> {
    info.replaceChildren(
      el("div", { class: "k", text: "当前配置" }),
      el("div", { class: "v", text: "读取中…" }),
    );
    card.append(info);
    try {
      const n = await api.getProfile();
      info.querySelector(".v")!.textContent = `#${n + 1}`;
    } catch (e) {
      info.querySelector(".v")!.textContent = `读取失败: ${e}`;
    }
  }

  const row = el("div", { class: "row" });
  for (const n of [0, 1, 2]) {
    const b = el("button", { class: "btn", text: `切换到配置 ${n + 1}` });
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api.switchProfile(n);
        await refresh();
      } catch (e) {
        alert(`切换失败: ${e}`);
      } finally {
        b.disabled = false;
      }
    };
    row.append(b);
  }
  card.append(row, el("p", {
    class: "sub",
    style: "margin-top:12px",
    text: "注意：切换后设备立即生效；每个配置是独立的一套键位/宏/设置。",
  }));
  await refresh();
}
