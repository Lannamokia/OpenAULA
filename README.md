# AULA Driver (unofficial)

AULA 键盘（HERO 68 XS 机型族）非官方驱动的起点：**Tauri v2 + Rust + Vite/TypeScript**。
协议实现移植自姊妹项目 `spiderdriver` 的逆向成果（`docs/protocol.md` / `docs/commands.md` /
`docs/keycodes.md` 与真机验证过的参考实现 `tools/aula_hid.py`），语义与其保持一致。

> ⚠ 本项目与 AULA 官方无关。写命令（改键 / 宏 / 配置切换）会修改设备板载存储，请自担风险。

## 目录结构

```
├── index.html / vite.config.ts / tsconfig.json / package.json
├── src/                      # 前端（原生 DOM + CSS 变量，深色主题）
│   ├── main.ts               #   外壳：侧栏导航 + 页面调度
│   ├── api.ts                #   Tauri invoke 封装（类型化）
│   ├── data.ts               #   数据表加载 + 键码判型/命名（含固件 Fn 功能键 0x07/0x08/0x09）
│   ├── ui.ts                 #   DOM 助手 / toast
│   ├── style.css             #   深色主题（CSS 变量、卡片式布局）
│   ├── data/                 #   机型/键码/布局/灯光效果 JSON（前端副本）
│   └── pages/                #   devices / status / keymap / advanced / macros / lighting / music / profiles / debug
├── src-tauri/
│   ├── Cargo.toml            # tauri 2 / hidapi 2 / serde 1 / wasapi 0.25 / rustfft 6 / winreg 0.55
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   ├── data/                 # 同一份数据表的 Rust 侧副本（include_str! 内嵌）
│   ├── icons/icon.png
│   ├── examples/probe.rs     # 只读真机探测（uuid/固件/电量/配置/键位/宏/高级键/灯光/触发/开关）
│   └── src/
│       ├── main.rs           # Tauri 入口 + 命令注册
│       ├── hid.rs            # 枚举/按 usage_page=0xFF60+usage=0x61 过滤/打开
│       ├── proto.rs          # 帧/应用包/CRC/ACK/分帧/写路径预处理/事件判型
│       ├── service.rs        # 设备会话：链路自适应 exchange + 各服务操作
│       ├── lighting.rs       # 灯区/逐键 RGB/灯箱/自定义区 + 灯光命令
│       ├── macros.rs         # 宏区解析与整段回写 + 宏命令
│       ├── advanced.rs       # 七种高级键的编解码 + 高级键命令
│       ├── music.rs          # 神光同步：WASAPI 回环 + FFT + 频段→键帧 + 主题色（不碰 HID）
│       ├── trigger.rs        # 磁轴：行程/RT/死区/轴体/AD范围/校准/行程监测流
│       ├── settings.rs       # 设备级开关：OS 模式/休眠/Win 锁/回报率/消抖/低功耗/…
│       └── commands.rs       # #[tauri::command] 前端接口
└── tools/gen_layout.py       # 重新生成 data/layout68.json（坐标 + 键名/默认键码）
```

## 怎么跑

```bash
npm install            # 安装前端依赖 + @tauri-apps/cli
npm run tauri dev      # 开发模式（Vite + cargo tauri dev）
npm run build          # 仅前端：tsc 类型检查 + vite build
npm run tauri build    # 打包桌面应用（需要 Rust 工具链）
```

仅 Rust 侧检查 / 测试 / 真机只读探测：

```bash
cd src-tauri
cargo check --all-targets
cargo test --lib             # 宏与高级键编解码的单元测试（7 个）
cargo run --example probe    # 打开设备，只读：uuid/固件/电量/配置/三配置名/键位/宏/高级键/四灯区
```

## 功能页

| 页 | 做什么 |
|---|---|
| 设备 | 枚举并打开配置接口（按 `usage_page 0xFF60 / usage 0x61` 过滤） |
| 设备信息 | UUID / 固件 / 电量 / 当前配置 |
| 改键 | 三层（基础/Fn/Fn1）键位读写；7 类键码选择器 + 搜索 + hex 手输；**宏绑定**；高级键标记 |
| 高级键 | TGL / MT / DKS / SOCD / MPT / END / RS 七种高级键的增删改查（`0x12`/`0x92`） |
| 触发设置 | 磁轴：轴体选择/应用、单键行程、快速触发 RT、顶部/底部死区、行程测试、轴体校准 |
| 宏 | 宏列表 + 动作编辑器 + 按键录制 + 容量估算 + **绑定到任意层任意键**（`0x85`/`0x05`） |
| 灯光 | 灯区效果/亮度/速度/颜色、OFF/ON 开关（记住原效果）、全键单色、逐键改色、自定义区持久化 |
| 神光同步 | 系统音频频谱驱动键盘灯 + Windows 主题色同步（WASAPI 回环 + FFT） |
| 板载配置 | 三个配置的切换与**改名**，标记当前配置 |
| 系统设置 | Mac 模式 / Win 键锁定 / 自适应校准 / 连击优化 / 回报率 / 低功耗 / 休眠 / WASD 互换 / 侧灯同步 / 消抖 |
| 原始命令 | 直接收发任意 `cmd/param/data`，排错用 |

## 协议要点（移植自 spiderdriver）

- 应用包 63 字节信封：cmd/param/总包数/包号/长度/数据/校验（`crc = 0xF6 - Σ(前62字节)`）。
- **读取是事件驱动的，不是轮询**：`AulaDevice` 用**第二个 HID 句柄**起一个常驻读线程
  （`read_timeout` 阻塞读，有数据时立即返回），把每个报文推进 mpsc 队列；主线程只负责写，
  收到的数据从队列里取。厂商网页用的是 WebHID `inputreport` 事件，这是它的等价物。
  ⚠ 不要退回"固定窗口轮询 `read_timeout`"的写法——Windows 上带超时的
  `WaitForSingleObject` 会被量化到 **~15.6ms** 的系统计时器粒度，实测刷新率封顶 64 次/秒、
  行程流只能收到 ~2% 的包（详见下方实测对比）。
- **链路自适应**：`PID == 0x106C`（8K 无线接收器）走 `0x66` 帧 + 逐帧 ACK；
  其它（如有线 `0x103E`）63 字节整包直发，无帧级 ACK。判据与 SDK `isWireless8K` 一致。
- `dataLength` 字段对读命令不可靠，必须按 `docs/commands.md` 的固定应答长度硬读。
- 宏包需 `inject_macro_offsets`（偏移覆盖 param 字节）、高级键包需 `inject_advanced_type`
  （类型写入 `[2]`），两者均重算校验。
- 宏区 = `[头表][宏体]`，头表每条 4 字节**小端** `{offset, length}`；表长 = 第一条的 offset。
  **写宏必须整段回写**，只写部分会擦掉其余宏。
- 配置切换 `0x10` 的配置号在 **data 字节**，不在 param。
- 主动上报 `cmd ∈ {0xFE, 0x98, 0x94}` 不作应答处理（仍须回 ACK）。

## 功能状态

### 已在真机验证（有线 HERO 68 XS, PID 0x103E —— 继承自 spiderdriver 的结论）

以下功能由 `tools/aula_hid.py` 在同型号设备上实测通过；本仓库 Rust 代码按相同语义移植，
**移植后的 Rust 代码仅做过只读冒烟（probe example），写路径未逐一复测**：

| 功能 | 命令 | 原项目 | 本仓库 Rust |
|---|---|---|---|
| 电量 / 充电状态 | `0x87` | ✅ 实测 | 只读实测 |
| UUID / 固件版本 | `0x82/0x01` `/0x02` | ✅ 实测 | 只读实测 |
| 键位映射读（三层） | `0x83` | ✅ 实测 | 只读实测（id 1） |
| 键位映射写 | `0x03` | ✅ 实测 | 未复测 |
| 板载配置读/切 | `0x90` / `0x10` | ✅ 实测（3 个配置，越界被拒） | 只读实测 |
| 开关位图/能力 | `0x82/0x03` `/0x0f` 等 | ✅ 实测 | 经原始命令面板可用 |
| 宏区整段读 | `0x85`（含偏移注入） | ✅ 实测 | 未复测 |
| 高级键写/删 | `0x12`（含类型注入） | ✅ 实测 | 未复测 |
| 8K 无线链路（`0x66` 分帧 + ACK） | — | ✅ 实测（0x106C 接收器） | 未复测（无设备） |
| 灯区整块读/写（主灯 / 侧灯） | `0x84/<base>` / `0x04/<base>` | ✅ 实测 | ✅ 写-读回-还原实测（2026-10-06） |
| 灯光 OFF/ON 开关 | `0x04/<base>`，effectId 0/1 | ✅ 实测 | ✅ 实测（主灯 `0x01` / 侧灯 `0x06`） |
| 全键单色 / 每键改色 | `0x08/2` `/1` | ✅ 实测 | 未复测 |
| 灯区能力块 `0x82/0x09` | `0x82` | ✅ 实测 | 只读实测 |
| 宏整段读 + 整段写 | `0x85` / `0x05` | ✅ 实测 | ✅ 实测（写 1 条 → 读回逐字段一致 → 清空还原） |
| 高级键写/读/删 | `0x12` / `0x92` | ✅ 实测 | ✅ 实测（TGL 写 id67 → 读回一致 → 列表出现 → 删除 → 列表空） |
| 自定义灯区持久化 | `0x06/0` 写 / `0x86/0` 读 | ✅ 实测 | ✅ 写-读回-还原实测（单 id） |
| 配置改名 | `0x1A/` 写 / `0x9A/` 读 | ✅ 实测 | ✅ 实测（写 UTF-8 名 → 读回 → 长度 0 清空） |
| 磁轴行程 / RT / 死区 / 轴体 / AD 范围 | `0x93`,`0x99`,`0x96`,`0x95`,`0x94/5` | ✅ 实测 | ✅ 写-读回-还原实测（行程/RT/死区） |
| 行程监测流 | `0x98` param 1 起 / 2 停，流为 param 1 | ⚠ 文档曾记错 | ✅ 实测（指定键 → 持续上报 → 停流归零） |
| 设备级开关（OS 模式/休眠/Win 锁/回报率/…） | `0x84/<n>` / `0x04/<n>` | ✅ 实测 | ✅ 实测（Win 键锁定 写-读回-还原） |
| 轴体校准 | `0x94/0` 起 / `0x94/4` 停 | ✅ 实测 | ✅ 实测（15s 收到 242 条进度上报，停后归零） |

### 真机实测补充（HERO 68 XS 有线，2026-10-06）

- 本机型**只有主灯（base 1）与侧灯/氛围（base 6）两个真实灯区**。`0x84/11`（Logo）与 `0x84/35`
  （灯箱）**会应答**且返回全 0，但写入 effectId 被 ACK 后**读回不变**（不落存储）——能力块也不报告它们
  （`0x82/0x09 [19]=0`、`[21..24]=0`）。**但 Fn+X / Fn+C / Fn+Z 不是空操作**——这一组功能键作用在
  **侧灯（氛围灯，base 6）** 上：颜色切换 / 亮度切换 / 速度切换。初版文档把 `0x08 <attr> <dir> <target>`
  的 `target=1` 推成了「灯箱」，用户实机按键纠正为侧灯（见 `docs/keycodes.md` §6.1）。
- 键盘灯效与氛围灯效的 OFF/ON 就是 `0x04/<base>` 写 effectId `0↔非0`；**本驱动不照抄官方**「开」写死
  effectId=1 的行为，而是关灯前记住原 effectId（按板载配置存 localStorage），开灯写回原效果。

### 源码推导、未实测（详见 spiderdriver `docs/` 的「尚未确定」清单）

- 有线链路的整包直发：格式来自 SDK 源码推导；本机有线实测确认可用，但**多包写**未实测。
- `*ByWireless` 裸报文（灯光专用通道）未实测；`0x0A` 接收器上报字段未确定。
- 灯光单属性读（`0x84/2..5`）在本机固件未实现；单属性写未逐个实测。
- 自定义灯光区读（`0x86/0`，逐键 RGB）**多 id 批量读在本机返回错位数据**（单 id 正常），暂未接入驱动；
  写路径 `0x06/0` 未实测。
- SDK 里还存在**另一套灯光服务**（`0xAA` 头的裸报文，usagePage `0xFF67`，cmd 16/27/29/36/43/45），
  本机型走的是应用包那套；详见 spiderdriver `docs/commands.md` §4.6。
- 磁轴 RT/死区/校准进度事件里的 `press`/`finished` 取位未确证。
- 鼠标/接收器侧另一套协议（`0x0F/0x23/0x25` 等）仅记录，未实现。

## 构建状态（2026-10-06，本机 Windows）

| 检查 | 结果 |
|---|---|
| `cargo check --all-targets` | ✅ 通过（0 error / 0 warning；tauri 2.12 / hidapi 2.6 / wasapi 0.25 / rustfft 6 / winreg 0.55） |
| `cargo test --lib` | ✅ 7 passed（宏区/动作编解码 + 七种高级键编解码往返） |
| `npm install` | ✅ 通过（vite 6.4 / typescript 5.9 / @tauri-apps/cli 2.x） |
| `npm run build`（tsc + vite build） | ✅ 通过 |
| `npm run tauri dev` / `tauri build` | 未运行（需要桌面会话；未验证打包） |
| `cargo run --example probe`（有线 HERO 68 XS 只读） | ✅ 通过：PID 0x103E、UUID `12 00 00 00 00 10`、固件 23.0.1、电量 100% 充电中、三层配置名、键位、宏区、高级键列表、四灯区状态 |
| 9 个页面渲染冒烟（stub IPC + 真浏览器） | ✅ 零 JS 错误、零未实现命令 |
| 真机写路径（临时 example，跑完已删） | ✅ 灯区、宏整段写、高级键 TGL、自定义区、配置改名、宏绑定 keycode 全部「写→读回→还原」通过 |
| 神光同步音频链路（临时 example，跑完已删） | ✅ 播 WAV 时 frames 55→337、peak≈0.5、频段随声音起伏；`music_frame` 出 68 键 |

注：首次构建需联网拉取 crates.io / npm registry 依赖；以上为依赖缓存完成后的结果。
