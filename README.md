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
│   ├── data.ts               #   数据表加载 + 键码判型/命名
│   ├── ui.ts                 #   DOM 助手 / toast
│   ├── style.css             #   深色主题（CSS 变量、卡片式布局）
│   ├── data/                 #   机型/键码/布局 JSON（前端副本）
│   └── pages/                #   devices / status / keymap / profiles / debug
├── src-tauri/
│   ├── Cargo.toml            # tauri 2 / hidapi 2 / serde 1
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   ├── data/                 # 同一份数据表的 Rust 侧副本（include_str! 内嵌）
│   ├── icons/icon.png
│   ├── examples/probe.rs     # 只读真机探测（cargo run --example probe）
│   └── src/
│       ├── main.rs           # Tauri 入口 + 命令注册
│       ├── hid.rs            # 枚举/按 usage_page=0xFF60+usage=0x61 过滤/打开
│       ├── proto.rs          # 帧/应用包/CRC/ACK/分帧/写路径预处理/事件判型
│       ├── service.rs        # 设备会话：链路自适应 exchange + 各服务操作
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

仅 Rust 侧检查 / 真机只读探测：

```bash
cd src-tauri
cargo check --all-targets
cargo run --example probe    # 打开设备，只读：UUID/固件/电量/当前配置/1 条键位
```

## 协议要点（移植自 spiderdriver）

- 应用包 63 字节信封：cmd/param/总包数/包号/长度/数据/校验（`crc = 0xF6 - Σ(前62字节)`）。
- **链路自适应**：`PID == 0x106C`（8K 无线接收器）走 `0x66` 帧 + 逐帧 ACK；
  其它（如有线 `0x103E`）63 字节整包直发，无帧级 ACK。判据与 SDK `isWireless8K` 一致。
- `dataLength` 字段对读命令不可靠，必须按 `docs/commands.md` 的固定应答长度硬读。
- 宏包需 `inject_macro_offsets`（偏移覆盖 param 字节）、高级键包需 `inject_advanced_type`
  （类型写入 `[2]`），两者均重算校验。
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

### 源码推导、未实测（详见 spiderdriver `docs/` 的「尚未确定」清单）

- 有线链路的整包直发：格式来自 SDK 源码推导；本机有线实测确认可用，但**多包写**未实测。
- `*ByWireless` 裸报文（灯光专用通道）未实测；`0x0A` 接收器上报字段未确定。
- 灯光单属性读（`0x84/2..5`）在本机固件未实现；单属性写未逐个实测。
- 磁轴 RT/死区/校准进度事件里的 `press`/`finished` 取位未确证。
- 鼠标/接收器侧另一套协议（`0x0F/0x23/0x25` 等）仅记录，未实现。

## 构建状态（2026-10-05，本机 Windows）

| 检查 | 结果 |
|---|---|
| `cargo check --all-targets` | ✅ 通过（0 error / 0 warning；tauri 2.12 / hidapi 2.6 / serde 1） |
| `npm install` | ✅ 通过（vite 6.4 / typescript 5.9 / @tauri-apps/cli 2.x） |
| `npm run build`（tsc + vite build） | ✅ 通过 |
| `npm run tauri dev` / `tauri build` | 未运行（需要桌面会话；脚手架阶段未验证打包） |
| `cargo run --example probe`（有线 HERO 68 XS 只读） | ✅ 通过：枚举到 PID 0x103E（整包直发链路），UUID `12 00 00 00 00 10`、电量 100% 充电中、当前配置 #3、基础层 id 1 = `0x00000029` (ESC)，与 spiderdriver 文档一致 |

注：首次构建需联网拉取 crates.io / npm registry 依赖；以上为依赖缓存完成后的结果。
