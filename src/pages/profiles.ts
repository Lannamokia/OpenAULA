import { api } from "../api";
import { beginLoading, el, toast } from "../ui";

/** 本机板载配置数量（实测 3 个，0-based；越界写入会被设备拒绝）。 */
const PROFILE_COUNT = 3;
/** 名称上限：协议 55 字节，UI 按字符收紧到 20。 */
const MAX_NAME_CHARS = 20;

export async function renderProfiles(page: HTMLElement): Promise<void> {
  page.replaceChildren(
    el("h1", { text: "板载配置" }),
    el("p", {
      class: "sub",
      text: "管理三套板载配置：切换配置、修改名称。",
    }),
  );

  const listCard = el("div", { class: "card" }, el("h2", { text: "三个配置" }));
  page.append(listCard);

  let current: number | null = null;
  const names = new Map<number, string | null>();
  /** 每个配置正在编辑的名称（本地草稿）。 */
  const drafts = new Map<number, string>();

  async function refresh(): Promise<void> {
    const task = beginLoading("正在读取板载配置…");
    try {
      try {
        current = await api.getProfile();
      } catch (e) {
        current = null;
        listCard.replaceChildren(
          el("h2", { text: "三个配置" }),
          el("div", { class: "empty", text: `读取当前配置失败: ${e}` }),
        );
        return;
      }
      for (let i = 0; i < PROFILE_COUNT; i++) {
        if (!drafts.has(i)) {
          task.setText(`正在读取配置 ${i + 1}/${PROFILE_COUNT} 的名称…`);
          try {
            names.set(i, await api.readProfileName(i));
          } catch {
            names.set(i, null);
          }
          task.setProgress((i + 1) / PROFILE_COUNT);
        }
      }
      render();
    } finally {
      task.done();
    }
  }

  function render(): void {
    listCard.replaceChildren(
      el(
        "h2",
        {},
        "三个配置",
        el("span", { class: "hint", text: "改名会写入键盘" }),
      ),
    );
    for (let i = 0; i < PROFILE_COUNT; i++) {
      const isCurrent = current === i;
      const draft = drafts.has(i) ? drafts.get(i)! : (names.get(i) ?? "");

      const nameIn = el("input", {
        type: "text",
        maxlength: String(MAX_NAME_CHARS),
        placeholder: "未命名",
        value: draft,
        style: "min-width:220px",
      }) as HTMLInputElement;
      nameIn.oninput = () => drafts.set(i, nameIn.value);

      const switchBtn = el("button", {
        class: `btn${isCurrent ? "" : " primary"}`,
        text: isCurrent ? "已是当前配置" : "切换到此配置",
      }) as HTMLButtonElement;
      switchBtn.disabled = isCurrent;
      switchBtn.onclick = async () => {
        switchBtn.disabled = true;
        try {
          await api.switchProfile(i);
          toast(`已切换到配置 ${i + 1}`);
          drafts.clear();
          await refresh();
        } catch (e) {
          alert(`切换失败: ${e}`);
        } finally {
          switchBtn.disabled = false;
        }
      };

      const saveBtn = el("button", { class: "btn", text: "保存名称" }) as HTMLButtonElement;
      saveBtn.onclick = async () => {
        const name = (drafts.get(i) ?? names.get(i) ?? "").trim();
        if (name.length > MAX_NAME_CHARS) {
          alert(`名称最多 ${MAX_NAME_CHARS} 个字符`);
          return;
        }
        saveBtn.disabled = true;
        try {
          await api.writeProfileName(i, name);
          names.set(i, name === "" ? null : name);
          drafts.delete(i);
          toast(`配置 ${i + 1} 名称已写入`);
          await refresh();
        } catch (e) {
          alert(`写入名称失败: ${e}`);
        } finally {
          saveBtn.disabled = false;
        }
      };

      const clearBtn = el("button", { class: "btn danger", text: "清空名称" }) as HTMLButtonElement;
      clearBtn.onclick = async () => {
        clearBtn.disabled = true;
        try {
          await api.writeProfileName(i, "");
          names.set(i, null);
          drafts.delete(i);
          toast(`配置 ${i + 1} 名称已清空`);
          await refresh();
        } catch (e) {
          alert(`清空失败: ${e}`);
        } finally {
          clearBtn.disabled = false;
        }
      };

      const card = el(
        "div",
        {
          style: `padding:12px 0;border-top:1px solid var(--border);${isCurrent ? "border-left:3px solid var(--accent);padding-left:12px;" : ""}`,
        },
        el(
          "h2",
          {},
          `配置 ${i + 1}`,
          isCurrent ? el("span", { class: "hint", text: "● 当前" }) : el("span", { class: "hint", text: "" }),
          el("span", {
            class: "hint",
            text: names.get(i) ? `设备名称: ${names.get(i)}` : "设备名称: （未命名）",
          }),
        ),
        el("div", { class: "row" }, el("label", { class: "field" }, "名称", nameIn), saveBtn, clearBtn, switchBtn),
      );
      listCard.append(card);
    }
    listCard.append(
      el("p", {
        class: "sub",
        style: "margin-top:12px",
        text: "切换立即生效，键盘灯效与键位会随之改变。名称最长 20 字符。",
      }),
    );
  }

  await refresh();
}
