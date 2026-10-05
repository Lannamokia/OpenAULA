# 命令参考（逐条：功能 / cmd / param / 参数）

本文是 `docs/protocol.md` 的配套命令手册：每条读/写命令对应什么功能、用哪个 `cmd/param`、
要传几个参数、请求与应答的数据区怎么排布。

**标记说明**：方法名后带 `✓` 的表示本机真机实调通过（`0x82/0x84` 读类）；
其余为 SDK 源码静态提取，字段偏移可对照源码行号复核。

**通用规则**（源码位置见文末）：

1. `protocol.encode(cmd, param, data, perPacketMax)` → 63 字节应用包；第 4 参是**每包数据上限**，
   默认 56。数据超限自动拆成 `totalPackets > 1` 多包，每包各自走链路层 5 帧。
2. `decode(response, n)` 的第二参**覆盖**包内长度字节，直接从 63 字节缓冲切 n 字节（尾部是补零）。
   **设备在返回数据时经常把 `dataLength` 填 0**（实测 `0x82/0x03`、`0x82/0x09`、`0x90`、`0x82/0x0f`），
   所以客户端必须按本表给出的**应答长度**取数据，用 `dataLength` 判断有无数据会误判成"无应答"。
   本表「应答 data」列即按固定长度解读的结果。
3. 写命令走 `transport.send`（不解析应答）；读命令走 `sendRecv`/`send`（等应答）。
4. 参数编码约定：`BE16`=2 字节大端，`BE32`=4 字节大端，`LE16`=2 字节小端；无特别说明就是 1 字节。
5. `param` 常是**位域**而非枚举：`encodeLayerAndSystem(layer, system) = (layer & 3) | ((system & 7) << 2)`，
   默认 `Normal(0)` + `Windows(0)` → `param = 0`。
6. 校验和（请求/应答同一规则）：`crc = 255 - ((9 + Σ packet[0..61]) mod 256)`。

---

## 1. 设备与主控 `IBaseService`

### 1.1 读取

| 方法 | cmd | param | 入参 | 请求 data | 应答 data |
|---|---|---|---|---|---|
| `getBatteryStatus` ✓ | `0x87` | – | 无 | 空 | `[0]`=电量%；`[1]` 高 4 位→充电中，低 4 位→充满 |
| `loadUuid` ✓ / `getUuid` | `0x82` | `0x01` | 无 | 6×`00` 占位 | 6 字节**大端**整数 = UUID（SDK 转 `Number()`，超 2^53 会丢精度） |
| `getFirmwareVersion` ✓ | `0x82` | `0x02` | 无 | 2×`00` 占位 | 2 字节小端 `v`：`major=v>>8`、`minor=(v>>4)&15`、`subminor=v&15`（实测 278） |
| `getSupportedSwitches` ✓ | `0x82` | `0x03` | 无 | 空 | 位图（LSB 起）：bit i ⇒ 开关 i 支持 |
| `getSupportedAdvancedKeyTypes` ✓ | `0x82` | `0x04` | 无 | 空 | 跳过首字节后取位图，bit0..6 ⇒ TGL/MT/DKS/SOCD/MPT/END/RS |
| `getMinRapidTrigger` ✓ | `0x82` | `0x06` | 无 | 空 | 1 字节，最小快速触发值 |
| `getTravelPrecision` ✓ | `0x82` | `0x08` | 无 | 空 | 1 字节，触发行程精度 |
| `checkLightingSupported` ✓ | `0x82` | `0x09` | 无 | 空 | 见 §4.1（灯光能力） |
| `getLegacyDisplaySupport` | `0x82` | `0x0c` | 无 | 空 | 1 字节位图 → 位序号集合（0=LCD，1=LED） |
| `checkLowPowerModeSupported` ✓ | `0x82` | `0x0d` | 无 | 空 | 1 字节，`1`=支持 |
| `checkWirelessDedicatedSupported` ✓ | `0x82` | `0x0e` | 无 | 空 | 1 字节，`1`=支持 |
| `loadDeviceFeatures` ✓ / `getDeviceFeatures` | `0x82` | `0x0f` | 无 | 空 | 56 字节能力块，字段见下表 |
| `getOsMode` ✓ | `0x84` | `0x11`(17) | 无 | 空 | 1 字节：`0`=Windows，`1`=macOS |
| `getSleepTime` ✓ | `0x84` | `0x13`(19) | 无 | 空 | 2 字节**大端**毫秒 |
| `getWinKeyLock` ✓ | `0x84` | `0x15`(21) | 无 | 空 | 1 字节，`1`=已锁 Win 键 |
| `getPollingRate` ✓ | `0x84` | `0x17`(23) | 无 | 空 | 1 字节档位码（见附录 A） |
| `getComboOptimization` ✓ | `0x84` | `0x18`(24) | 无 | 空 | 1 字节，`1`=开 |
| `getAdaptiveCalibration` ✓ | `0x84` | `0x19`(25) | 无 | 空 | 1 字节，`1`=开 |
| `getDebounceMode` ✓ | `0x84` | `0x1d`(29) | 无 | 空 | 1 字节，见附录 A |
| `getDebounceTime` ✓ | `0x84` | `0x1e`(30) | 无 | 空 | 2 字节**大端**毫秒 |
| `getLowPowerModeEnabled` ✓ | `0x84` | `0x20`(32) | 无 | 空 | 1 字节，`1`=开 |
| `getWasdArrowKeysSwapped` ✓ | `0x84` | `0x21`(33) | 无 | 空 | 1 字节，`1`=已互换 |
| `getSideLightSync` ✓ | `0x84` | `0x22`(34) | 无 | 空 | 1 字节，非 0 = 开 |
| `getKeyboardType` | 复用 `0x82/0x03` | – | 无 | – | 由开关位图推导：非空→`magnetic`，空→`mechanical` |
| `getKeyMatrixPositions` | `0xA5` | `0x00` | `ids:number[]` | 每个 id `BE16`（每包 ≤28 个） | 每 2 字节一组，顺序同请求：`[2k]`=列，`[2k+1]`=行 |
| `getBasics` | `0x01` | `0x00` | 无 | 空 | 17 字节：`[0..1]`LE16 版本、`[2..7]`UUID、`[8]`连接状态、`[9]`状态码、`[10]`bit7 充电/bit0-6 电量、`[11]`高 4 位最大配置数/低 4 位当前、`[12]`最大回报率、`[13]`传感器、`[14..15]`LE16 最大 DPI（`(v+1)*50`）、`[16]`宏容量 |

`loadDeviceFeatures` 应答字段（块内偏移）：

| 偏移 | 含义 |
|---|---|
| `[0]` bit0 / bit1 | `lcdDisplay` / `dotMatrixDisplay` |
| `[1]` | `lowPowerMode` |
| `[2]` | `wirelessDedicatedChannel` |
| `[3]` bit0 / bit1 | `winMode` / `macMode` |
| `[4]` | `wasdArrowSwap` |
| `[5..6]` BE16 bit0 / bit1 | `wheel` / `slider` |
| `[7..8]` BE16 | `maxUrlLength` |
| `[9]` bit0/1/2/3/4 | `keyIdRGB` / `fullKeysRGB` / `ledBeadTable565` / `ledBeadRGB565` |
| `[12]` `&7` / bit7 | `switchTriggerStage`（2=TwoStage）/ `switchMixing`（仅非磁轴） |
| `[13]` | 录制灯效存储容量 |
| `[14]` `×0.5` / `[15]` `×0.5` | 文本宏存储容量 / 单条长度 |
| `[16]` | `lightingEffectDirection`（1=支持） |
| `[17]` | `sideLightSync` |
| `[18]`（缺省 3） | 配置文件数量 |
| `[19]` | 主灯色彩能力：1=Monochrome，否则 FullColor |

> 本机实测值（键盘 = WIN68 Ultra 系磁轴，固件 278）：
> UUID `12 00 00 00 00 10`（= 19791209299984）、电量 99%、充电中、轮询率档 0、Win 键未锁、
> 低功耗支持且已开、WASD 未互换、侧灯未同步、配置数 3、当前配置 1、休眠 0、消抖时间 0、消抖模式 0。
> `getSupportedSwitches` 位图 = `3a e1 40 09 20 00 00 78` → 支持的开关号 `[1,3,4,5,8,13,14,15,22,24,27,37,59,60,61,62]`。
> ⚠ `loadDeviceFeatures`（`0x82/0x0f`）在本机**返回全 0**，SDK 报出的 `lcdDisplay:false / profileCount:3`
> 等值是从补零缓冲里读出来的默认值（`[18]||3`），不是设备真实能力。

### 1.2 写入

| 方法 | cmd | param | 入参 | 请求 data |
|---|---|---|---|---|
| `changeOsMode` | `0x04` | `0x11`(17) | `mode: 0\|1` | `[0]`=0 Windows / 1 macOS |
| `setSleepTime` | `0x04` | `0x13`(19) | `ms: 0..65535` | 2 字节大端 |
| `setWinKeyLock` | `0x04` | `0x15`(21) | `locked: boolean` | `[0]`=0/1 |
| `setPollingRate` | `0x04` | `0x17`(23) | `rate: 0..6` | `[0]`=档位码（附录 A） |
| `setComboOptimization` | `0x04` | `0x18`(24) | `enabled: boolean` | `[0]`=0/1 |
| `setAdaptiveCalibration` | `0x04` | `0x19`(25) | `enabled: boolean` | `[0]`=0/1 |
| `setDebounceMode` | `0x04` | `0x1d`(29) | `mode: 0..3` | `[0]`=模式码（附录 A） |
| `setDebounceTime` | `0x04` | `0x1e`(30) | `ms: 0..65535` | 2 字节大端 |
| `setLowPowerModeEnabled` | `0x04` | `0x20`(32) | `enabled: boolean` | `[0]`=0/1 |
| `setWasdArrowKeysSwapped` | `0x04` | `0x21`(33) | `swapped: boolean` | `[0]`=0/1 |
| `setSideLightSync` | `0x04` | `0x22`(34) | `enabled: boolean` | `[0]`=0/1 |
| `setEffect` / `setLightSpeed` | `0x04` | 见 §4.2 | 见 §4.2 | 见 §4.2 |

---

## 2. 按键映射 `IKeymapService`

| 方法 | cmd | param | 入参 | 请求 data | 应答 data |
|---|---|---|---|---|---|
| `getKeymap` ✓ | `0x83` | `ELS(layer, system)` | `{id, layer?, system?}` | `BE16(id)`（转发 `getKeymaps`） | 取第 1 条记录 → `{id, keycode}` |
| `getKeymaps` | `0x83` | `ELS` | `{ids:number[], layer?, system?}` | 每个 id `BE16`；**每包 ≤9 个 id**（上限 18 字节） | 按 6 字节切：`[0..1]`=id(BE16)、`[2..5]`=keycode(BE32，无符号) |
| `setKeymap` | `0x03` | `ELS` | `{id, keycode, layer?, system?}` | 转发 `setKeymaps` | 无 |
| `setKeymaps` | `0x03` | `ELS` | `{keycaps:[{id,keycode}], layer?, system?}` | 每条 6 字节：`BE16(id)` + `BE32(keycode)`；每包 ≤9 条，空数组报错 | 无 |
| `resetKeymaps` | `0x11` | `ELS` | `{layer?, system?}` | `[1]`（`KeyReset`） | 无 |
| `getSpecialKeys` | `0xA2` | `0x00` | 无 | 空 | 每 2 字节：`[0]`=类型掩码(1=滚轮,2=滑条)、`[1]`=功能掩码(1=单击,2=长按,4=双击)；对命中类型再串行发 `0xA2/0x01` |
| （内部）特殊键取值 | `0xA2` | `0x01` | `type` + `features[]` | `[0]`=类型掩码，随后每个功能 1 字节 | 跳过首字节，每 5 字节：`[0]`=类型、`[1..4]`=keycode(BE32) |
| `updateSpecialKeys` | `0x22` | `0x00` | `[{keyIndex, feature, keycode}]` | 每条 6 字节：`keyIndex, feature(位掩码), BE32(keycode)`；每包 ≤9 条 | 无 |
| `encodeRapidFireKeycode` | 本地 | – | `{normalKeycode, count, intervalMs}` | – | 合成 32 位：`0x10<<24 \| normalKeycode<<16 \| count<<8 \| intervalMs` |
| `isRapidFireKeycode` / `decodeRapidFireKeycode` | 本地 | – | `keycode` | – | 判顶字节 `==0x10`；拆回上面三个字段 |

> **keycode 是 32 位**，高字节是类型：`0x00`=普通键/修饰键/复合键、`0x01`=鼠标键、`0x02`=媒体键、
> `0x03`=宏键、`0x0d`=Fn、`0x10`=连发键、`0x12`=文本宏键。判型 `(keycode >>> 24) & 0xFF`；
> 读键值前先判型，否则会把连发码（如 `0x10050010`）当成普通键值。
> 完整键码表（170 项）、修饰位/复合键编码、改键页七类选项、本机型 68 键 id 表见 [`keycodes.md`](keycodes.md)。
>
> 改键只需三条命令：读 `0x83`（每包 ≤9 个 id）、写 `0x03`（每条 6 字节 `BE16(id)+BE32(keycode)`）、
> 复位 `0x11`（data `[1]`）。Fn 层/Windows-macOS 用 `param` 位域区分，不占键码空间。
> **键位 id 与型号绑定**（本机 68 键是 `[1, 15..77, 98, 99, 102, 103]`），不要遍历 id 空间——
> 不存在的 id 会返回规律性垃圾值。

---

## 3. 配置文件（板载配置）`IConfigService`

| 方法 | cmd | param | 入参 | 请求 data | 应答 data |
|---|---|---|---|---|---|
| `getProfile` ✓ | `0x90` | `0x00` | 无 | 空 | `[0]` = 当前配置序号 |
| `changeProfile` ✓ | `0x10` | `0x00` | `profile: 0..2` | **`[0]` = 序号**（注意：在 data 里，**不是 param**） | 无 |
| `getProfileName` ✓ | `0x9A` | `profile` | `profile` 序号 | 空 | `[0]`=名称字节长度 `L`；`L∈{0,255}`→空串（未命名）；否则 `[1..L]` 为 UTF-8 名称 |
| `getProfileNames` | `0x9A` ×N | 逐个 `profile` | `ids:number[]` | 每个 id 一条请求（并发） | `[{name, id}]`，顺序同入参 |
| `setProfileName` | `0x1A` | `profile` | `(profile, name)` | `[len, ...UTF-8]`，`len ≤ 55`（UI 限 20 字符） | 无 |

### 3.1 真机实测（有线 HERO 68 XS）

**板载配置共 3 个（`0..2`），切换功能已实现且工作正常**：

```
0x90 读当前        → 0
0x10/0 data=0/1/2  → 读回 0 / 1 / 2      ✓ 生效
0x10/0 data=3 / 4  → 读回 2（保持不动）   ✓ 越界被拒，确认上限就是 3 个
0x9A/0,1,2         → 名称长度均为 255     → 三个配置都未命名（空）
```

**改名读写实测通过（2026-10-06）**：

```
0x9A/1 初始         → data 全 ff（长度字节 0xff = 未命名）
0x1A/1 data = [09, "测试-P1"(UTF-8 9 字节)]  → 0x9A/1 读回同一串 UTF-8 ✓
0x1A/1 data = [00]                            → 0x9A/1 读回长度 0 = 已清空 ✓
```

即 `0x1A` 用**长度 0** 就能清空名称；名称按 UTF-8 原样存储，`len` 上限 55 字节。
（注：`0x9A` 的应答 `dataLength` 在未命名时是 56，**不要用 `[5]` 判断有没有名字**，
要看 data 第 0 字节。）

**三个配置各自独立存储键位**（可回滚实验，逐条验证后已全部还原）：

```
往同一个键 id 63 写不同值：
  配置 0 写 KeyA(0x04) → 读回 0x00000004 ✓
  配置 1 写 KeyB(0x05) → 读回 0x00000005 ✓
  配置 2 写 KeyC(0x06) → 读回 0x00000006 ✓
=> 切换配置不会串数据，每个配置是完整独立的一套键位
```

**UI 入口**：前端有 `/autoChangeConfig`「板载自动切换」页；配置序号存在 store 的 `profileIndex`；
键位表里还有一组可绑定到按键的「功能键」文案（`至配置文件2/3/4`、`全键锁`、`RT Toggle`、`灯效电源`、
`切换至 MAC 模式`、`切换配置文件` 等），说明**切换配置也可以绑成某个键的功能**（Fn 层常见用法）。

> 这类「功能键」在键位表里对应的编码就是 Fn 层实测到的 `0x07/0x08/0x09` 类型值
> （`0x070000xx`、`0x08xx0001`、`0x0900000x`）；它与那些文案的**逐一对应关系仍未确证**
> ——`keyboardMap` 的 181 条里没有这些值，驱动 UI 也只会回落显示该键的默认名。

---

## 4. 灯光 `ILightingLegacyService` / `ILightingService`

灯的每个「区域」有一套固定的 param 基址，同一区域内用 `base+n` 区分属性：

| 区域 | 基址 `base` | 完整效果 | +1 只改效果 id | +2 颜色 | +3 亮度 | +4 速度 |
|---|---|---|---|---|---|---|
| 主灯 Main | 1 | `0x84/1` 读 / `0x04/1` 写 | `0x04/2` | `0x04/3` | `0x04/4` | `0x04/5` |
| 侧灯 Side | 6 | `0x84/6` / `0x04/6` | `0x04/7` | `0x04/8` | `0x04/9` | `0x04/10` |
| Logo | 11 | `0x84/11` / `0x04/11` | `0x04/12` | `0x04/13` | `0x04/14` | `0x04/15` |
| 灯箱 Lightbox | 35 | `0x84/35` / `0x04/35` | `0x04/36` | `0x04/37` | `0x04/38` | `0x04/39` |

### 4.1 读取
| 方法 | cmd | param | 入参 | 应答 data |
|---|---|---|---|---|
| `getEffect` ✓ | `0x84` | `base(区域)` | `区域: 1\|2\|3\|4` | `[0]`=效果 id（0..18 预置，19=自定义）、`[1]`=`colorIndex`、`[2..4]`=R,G,B、`[5]`=亮度(**0..21**)、`[6]`=速度(**0..5**)、`[7]`=方向（仅主灯且设备支持）。本机实测 `03 00 90 ee 90 14 04` |
| `checkLightingSupported` ✓ | `0x82` | `0x09` | 无 | 数据区 56 字节（实测以 `ff ff 07` 开头，含义未定）。**本机 HERO 68 XS 实测（2026-10-06，8K 接收器）**：`[16]`=0x01、**`[17]`=0x05** → bit0 `musicMain` ✅ / bit1 `musicSpectrum` ❌ / bit2 `musicSide` ✅、`[18]`=31（侧灯，非 0=有）、`[19]`=0（无 Logo 灯）、`[20]`=**18**（侧灯灯珠数）、`[21..24]`=0（无灯箱）、`[25]`=0x00。⚠ **`[25]` 是"灯箱"支持的效果位图**（厂商把它嵌在 `lightbox` 对象里返回，不是键盘的），bit i ⇒ 灯箱效果 id i+1；本机无灯箱，所以是 0 |
| `getCustomMainLight` | `0x86` | `0x00` | `ids:number[]` | 每 5 字节：`BE16(id), R, G, B`；请求每包 ≤11 个 id |
| `getLedBeads` | `0xA1` | `0x00` | `ids:number[]` | 每颗：`BE16(id), count, {位置}×count`；位置字节 `x`：行=`x&7`、列=`(x>>3)&31` |
| `isLightingEffectDirectionSupported` | 无 | – | 无 | 取「设备能力」的 `lightingEffectDirection` |
| `isMixedColor` | 无 | – | `colorIndex` | 本地判断：`colorIndex >= 7`（≥7 = 随机/多彩模式） |

> **单属性读（`0x84/` + 属性 param）在本机固件上未被实现**：`0x84/2`(效果 id)、`0x84/3`(颜色)、
> `0x84/4`(亮度)、`0x84/5`(速度) 实测都返回 `len=0` + 全 0。读取请走 `0x84/<base>` 整块（7 字节）。
>
> 上面这张「属性偏移」表**也是 Fn 功能键的编号依据**：Fn 层里形如 `0x08 <attr> <dir> <target>`
> 的功能键（Fn+X 侧灯颜色切换、Fn+C 侧灯亮度切换、Fn+Z 侧灯速度切换、Fn+↑/↓ 输入区亮度±）里的 `attr`
> 就是这里的 2/3/4 —— 见 `keycodes.md` §6.1。

> **`getCustomMainLight`（`0x86/0`）在本机固件的批量读有坑**（2026-10-06 实测）：
> 单个 id 请求正常（如 `[37]` → 应答 data `00 25 00 00 00` = id 37 + RGB `00 00 00`），
> 但**一次请求多个 id 时返回数据错位**，且错法跟 id 大小有关：
>
> | 请求 ids | 应答 data | 解析结果 |
> |---|---|---|
> | `[37,38]` | `00 25 00 00 00 00 26 00 00 00` | ✅ 37、38 各一条 |
> | `[1,37]` | `00 01 00 00 00 00 25 00 00 00` | ✅ 正常 |
> | `[20,21]` | `00 14 00 00 00 00 15 00 00 00` | ✅ 正常 |
> | `[1,2]` | `00 01 00 00 00 00 00 00 00 00` | ❌ 第 2 条 id 变成 0 |
> | `[2,1]` | `00 02 00 01 00 00 01 00 00 00` | ❌ 第 1 条记录混入了下一个 id 的低字节 |
> | `[5,6]` | `00 05 00 06 00 00 00 00 00 00` | ❌ 看起来把请求原样回显 |
> | `[10,20,30]` | `00 0a 00 14 00 00 14 00 00 00 00 1e 00 00 ff` | ❌ 错位 |
>
> 结论：**要用就一次只读一个 id**，并用应答里的 id 回显做校验（不匹配就丢弃）。
> 写路径 `0x06/0` 是正常的：写 id 37 = 红色 → 读回 `00 25 ff 00 00` → 还原成功。

### 4.2 灯光总开关（真机实测）

「键盘灯效」与「氛围灯效」各有**独立**的 OFF/ON 开关，两者都只是 **`setEffect`（`0x04/<base>`）写 effectId=0/1**，
其余字段照抄页面当前值：

| 开关 | param | 关 OFF data | 开 ON data |
|---|---|---|---|
| 键盘灯效（主灯） | `0x01` | `00 00 90 ee 90 0c 03` | `01 00 90 ee 90 0c 03` |
| 氛围灯效（侧灯） | `0x06` | `00 00 90 ee 90 04 03` | `01 00 90 ee 90 04 03` |

- 两者 payload 布局相同：`[effectId, colorIndex, R, G, B, brightness, speed]`，**只改 effectId**
- 前端各自调用 `setEffect(lightType, …)`（`1`=主灯 / `2`=侧灯），SDK 内部经 `X2e` 表换算成 wire param `1`/`6`
- ⚠ **「开」在前端硬编码为 effectId = 1（常亮/常亮模式），不恢复原效果**——程序化控制时注意别依赖它"还原"
- 氛围灯那路**不带 direction 字节**（本机主灯实测也没带，因为能力块 `0x82/0x0f` 返回全 0）
- 与 Fn 功能键里的「灯效电源」**不是同一条**：后者是键位 keycode（type `0x07`），由固件执行

> **2026-10-06 有线 HERO 68 XS 复测**（读原位 → 写 → 读回 → 还原）：
>
> | 灯区 | base | `0x84/<base>` 初值 | 写 effectId=1 | 结论 |
> |---|---|---|---|---|
> | 主灯 | 1 | `01 00 90 ee 90 0c 03` | 读回 `01 …` | 真实、可写 |
> | 侧灯（氛围） | 6 | `00 00 90 ee 90 04 03` | 读回 `01 …`，还原回 `00 …` | 真实、可写 |
> | Logo | 11 | 全 0 | 读回仍全 0 | **写入被 ACK 但不落存储 → 本机型无此灯区** |
> | 灯箱 | 35 | 全 0 | 读回仍全 0 | 同上（能力块 `[19]=0`、`[21..24]=0` 也说不存在） |
>
> 所以本机枪身上没有灯箱/Logo 灯区。**注意**：Fn 层的 Fn+X / Fn+C / Fn+Z / Fn+RAlt 那几个功能键
> 初版文档按「装饰灯」推成了灯箱，**实际作用在侧灯（氛围灯）上**（用户实机按键纠正，见
> `keycodes.md` §6.1：`0x08 <attr> <dir> <target>` 的 `target=1` 是侧灯 base 6，不是灯箱）。
> **这一「写成功但读回不变」的判据，是新机型上识别灯区是否真实存在的最省事办法。**
>
> **二次开发建议**：驱动侧不要照抄官方「开灯写死 effectId=1」，关灯前先记住当前 effectId、
> 开灯写回它（灯光按板载配置存储，记忆也要按配置分键）。参考实现见 `aula-driver/src/pages/lighting.ts`。

### 4.3 参数取值范围（重要）

| 参数 | 协议取值 | 说明 |
|---|---|---|
| `brightness` 亮度 | **0..21** | 前端 UI 用 1..22，下发前 `-1`、读回后 `+1`（`light-BQUfhSVT.js` 里 `brightness: ui - 1` / `= cfg.brightness + 1`） |
| `speed` 速度 | **0..5** | 同上，UI 1..6 ↔ 协议 0..5 |
| `colorIndex` | 0..6 固定色，**7 = 随机/多彩** | 前端：`colorIndex: randomColor ? 0x7 : 0x0`；设备端不限色彩数量，RGB 直写 |
| `r/g/b` | 0..255 | 灯珠是 **WS2812 类可寻址 RGB**，三通道直接写，色彩数量不受硬件限制（`updateRGB` 走的就是逐键/逐色组 RGB888） |
| `effectId` | 0..18 预置，19=自定义 | 具体效果名与编号见前端灯光页与 `checkLightingSupported` 的效果位图 |
| `direction` | 仅主灯、且设备能力位支持时参与 | 枚举：0=None/Forward、1=Backward/Left、2=Right、3=Up、4=Down（源码里的方向枚举未被引用，仅供参考） |

### 4.4 写入

| 方法 | cmd | param | 入参 | 请求 data |
|---|---|---|---|---|
| `setEffect` ✓ | `0x04` | `base(区域)` | `{id, colorIndex, color:{r,g,b}, brightness, speed, direction?}` | 7 字节 `[id, colorIndex, r, g, b, brightness, speed]`；主灯且支持方向时追加 1 字节 → 8 字节（实测 `01 00 90 ee 90 14 02`） |
| `changeEffect` | `0x04` | `base+1` | `区域, effectId(0..19)` | 1 字节 |
| `setCustomMainLight` | `0x06` | `0x00` | `[{id, color:{r,g,b}}]` | 每组 5 字节 `BE16(id)+RGB`；每包 ≤11 组 |
| `updateFullKeysRGB` | `0x08` | `0x02` | `{r,g,b}` | 3 字节 |
| `updateRGB` | `0x08` | `0x01` | `[{id, color:{r,g,b}}]` | 先按颜色聚类压缩，再每组 `[r,g,b,count,...ids]`（id 各 1 字节）；总长 ≤255 |
| `updateRGBWithLedBeads` | `0x08` | `0x03` | `[{row,col,color}]` | 按 (列,行) 稳定排序后每颗 2 字节 RGB565（大端） |
| `updateLedBeadColors` | `0x08` | `0x04` | `[{id, color:{r,g,b}}]` | 聚类后每组 `[RGB565 BE16, count, ...ids]` |
| `updateLightboxRGB` | `0x29` | `0x03` | `[{r,g,b}]` | 每个颜色 2 字节 RGB565（大端），按矩阵顺序 |

> `updateRGB` / `updateLedBeadColors` 会做**聚类压缩**：组数超限时按 RGB 欧氏距离贪心选簇、
> 簇内取颜色**平均值**，所以设备最终拿到的颜色可能不是逐键原色。

### 4.5 无线裸报文变体（绕过应用包与 `0x66` 帧）

SDK 另有 `*ByWireless` 系列：直接 `sendReport(9, 19字节)`，格式
`[0x08, total, index, (type<<4)|len, data(≤13), 0 补齐, crc]`，`crc = 255-((9+Σpayload)%256)`。

| 方法 | type | 入参 | data |
|---|---|---|---|
| `updateFullKeysRGBByWireless` | 2 | `{r,g,b}` | 3 字节 RGB |
| `updateRGBByWireless` | 1 | `[{id,color}]` | 13 字节/包，并发发送 |
| `updateRGBWithLedBeadsByWireless` | 3 | `[{row,col,color}]` | 每颗 2 字节 RGB565，13 字节/包 |
| `updateLedBeadColorsByWireless` | – | – | 未实现（SDK 直接抛错） |

> ✅ **2026-10-06 真机实测通过（8K 接收器 PID 0x106C）**：发 60 帧只用 1.21s = **50 帧/秒
> （20ms/帧）**，比应用包路径在无线下的 185ms/帧**快约 9 倍**；发完链路照常工作，
> 标准通道也不受影响，**键盘确实按它渲染颜色**（音频律动跟得上）。
>
> 协议逐字节核实无误，补充两点早先没写清的：
> - `crc = 255 - (Σ **偏移 0..18** ) % 256` —— 求和**含 report id 的 9**；
> - `total` = 本帧报文数、`index` **从 0 起**；`updateRGBByWireless` 的 data 是
>   `.flatMap(...)`，即与应用包 `0x08/1` **逐字节相同的扁平数据**。
>
> ⚠ **误判记录**：曾因"发完 60 帧后命令连续超时"判定它会把接收器打死——**错了**，
> 那是**设备休眠**（无线键盘空闲即不应答，症状与链路死掉完全一样）。带对照组的重测
> （起始探测 → 空等 2s 对照 → 发 60 帧 → 之后每 0.6s 探 8 次）**全程正常**。
>
> 它存在的意义是**实时流式刷灯**，因为它无 ACK、不等应答、可以高频连发。
>
> 🔬 **校验行为已实测（8K 接收器，`openaula/src-tauri/examples/rawcrc.rs`）**：整键盘单色
> （`type 2`）各发一条 20 字节报文，两条只差最后 4 位——有效 `…6a` 派绿、`crc ^ 0x01` 的 `…6b` 派红：
>
> - **有效校验的绿正常显示** —— 顺带首次证实 `type 2`（`updateFullKeysRGBByWireless`）在本机固件上生效；
> - **坏校验的红从未出现** → **crc 确实被校验，坏报文被丢弃**（在接收器还是键盘上丢的，分不出来）；
> - 连续 8 轮坏报文**没有影响链路**（发完探测仍 `true`）；
> - ⚠ **"这条通道完全安静、零回报"的旧结论已作废（2026-10-06 复核）。** 设备对**每一条**输出报文
>   都会在输入端点上**回送**：长度 = 接口的报告长度，**最后一字节被替换成 `255 - Σ(该报文前 19 字节)`**。
>   实测四组逐字节吻合（含一组随机字节，前 18 字节与写进去的完全一致 → 不是缓冲区复用）：
>
>   | 写出去的（report id + payload） | 收回来的 |
>   |---|---|
>   | `[9] 5a×19` | `[9] 5a×18 a2` —— Σ(09+5a×18)=1629, 1629%256=93, 255-93=162=0xa2 ✓ |
>   | `[9] 08 01 00 15 00 …` | `[9] 08 01 00 15 00 … d8` —— Σ=39, 255-39=216 ✓ |
>   | `[9] 82 01 00 01 00 …`（应用包） | `[9] 82 01 00 01 00 … 72` —— Σ=141, 255-141=114 ✓ |
>   | `[9] 随机 19 字节` | 前 18 字节逐字节相同，末字节 = 255-Σ ✓ |
>
>   先前测到的"0 条"**是我们自己的过滤器造成的**：`drain_event_packets` 只认 63 字节的 `0x66`
>   事件包，这种 19 字节回送被直接跳过。**所以这条通道是有写侧回报的**——回送能证明**接收器收下了**，
>   但**不能**证明它转到了键盘（2.4G 那一段仍然无任何可见性）。
>
> **推论：位翻转不会变成乱色，它只会变成一个洞。** crc 保护的是"单条报文内的完整性"，
> 一帧由 6~13 条报文按 `total`/`index` 拼成，少一条就是**残帧**；而丢包这一层唯一的恢复手段
> 是重传，**这条通道没有**（整帧重发、错位、半帧应用会各自表现成什么，仍未验证）。
>
> 🧭 **官方 Web 前端从不调用这条通道（静态复核）**：全站 40+ 个 chunk（含重放字符串表解码后）
> 里 `*ByWireless` 系列**零调用者**；灯光页唯一下发点是 `device.lighting.setEffect(...)`，
> 全站没有 `AudioContext` / `getUserMedia` / `createAnalyser`。也就是说网页版的「音乐律动」
> 是**固件侧效果**，官方**没有任何"高频逐键刷色"的参考实现**，这条通道在厂商自己的产品里
> 没有行使记录，固件对它的处理无人验证过。（桌面版是否有别的流式实现，这批 web 素材判断不了。）
>
> 驱动项目 `openaula/` 的「神光同步」在无线下走这条快通道、有线走 `0x08/1`（`updateRGB`）：
> Rust 侧只做 WASAPI 回环采集 + FFT + 频段→键帧，前端按刷新率拉帧再下发。
> 架构与实测数据见 `openaula/NEXT.md`。

### 4.6 另一套灯光服务（老/侧信道，非本机型走法）

SDK 里除了上面的应用包服务，还有一套**独立的老式裸报文灯光服务**（`ILightingLegacyService` 一族），
走 **8 字节头**、包里以 `0xAA` 开头、应答以 `0x55` 开头，和 `0x66` 帧毫无关系：

```
请求:  AA <cmd> <len> <addr_lo> <addr_hi> <h5> <h6=isLast> <h7>  <data …>      总长 = 报告长度(32/64)
应答:  55 <cmd> <lenOrType> <addr_lo> <addr_hi> <…> <…> <…>  <data …>          data 从偏移 8 起
```

| 方法 | cmd | 有效载荷 |
|---|---|---|
| 灯箱读 `getLightBox` | 27 (`0x1B`) | 24 字节，`[0]`=mode `[1..3]`=RGB `[8]`=colorMode `[9]`=亮度 `[10]`=速度 |
| 灯箱写 `setLightBox` | 43 (`0x2B`) | 同上布局，24 字节 |
| 侧灯读 `getSideLight` | 29 (`0x1D`) | 同上布局 |
| 侧灯写 `setSideLight` | 45 (`0x2D`) | 同上布局 |
| 自定义灯区写（逐灯 `[index,r,g,b]`×4 字节） | 36 (`0x24`) | 长度 = 4×灯数 |
| 其它 | 16 / 17 … | 未逐条整理 |

> 枚举这条链路的设备时，SDK 用的是 **usagePage `0xFF67`**（不是本机型的 `0xFF60`）。
> **本机 HERO 68 XS（usage 0xFF60）走的是 §4.1–4.4 那套应用包协议**；这节仅作记录，
> 遇到走 `0xAA` 头的新机型/老固件时按此实现。定位：`tools/deobf-vendor/deobfuscated.js`
> 的 `jn`(126149) / `x6`(126233) / `TQe`(126262) 与 `getLightBox`(127170) / `setSideLight`(127226)。

#### 4.6.1 音乐数据 `SET_MUSIC_DATA`（已逆向，但**本机 8K 接收器用不了**）

厂商 SDK 里"音乐律动"走的就是这条 legacy 链路，**不是** §4.1–4.5 的逐键颜色应用包：

| 方法 | cmd | 线上格式 |
|---|---|---|
| `setMusicDataV1(r,g,b,spectrum[21])` | 53 (`0x35`) | 一整条 32/64 字节报告，report id 0：`[0xAA, 53, 0, r, g, b, spectrum[0..20], 0…, sum(x[0..30])&0xFF]`（校验和在 `x[31]`） |
| `setMusicData(frame, flag, isBigReport, mode)` | 53 / 60 | **逐珠整帧**：每珠 RGB→RGB565 = `(r&248)<<8 \| (g&252)<<3 \| (b&248)>>3`，再拆成 `[hi,lo]`。按报告长度分三支：非 64 → 每包 `(len-4)` 字节、自带头 `[0xAA, 53, 包号, flag]`；**64 且 mode=1 → `SET_MUSIC_DATA_24G_64_BYTE`(60)**，带地址、最后一包置标志；其它 → 按 `(len-8)` 切包走 `GET_LED_DATA`(50) + 地址 |

命令字表（SDK `Yt`）：`GET_LED_DATA:50`、`GET_ALL_LIGHTS_RGB:51`、`SET_TEMPORARY_COMMAND_DATA:52`、
**`SET_MUSIC_DATA:53`**、`CLEAR_LED_DATA:54`、`GET_ALL_LIGHTS_RGB_24G:55`、
`GET_ALL_LIGHTS_RGB_24G_64_BYTE:59`、`SET_MUSIC_DATA_24G_64_BYTE:60`、`SET_LED_DATA:66`。

`*_24G_*` 变体的存在 + `isNeedLastPacketFlag` 说明**这套协议自带"整帧是否完成"的语义**，
本来就是给 2.4G 无线设计的——这正是 §4.5 那条裸报文通道缺的东西。

> ⚠ **但本机走不了（2026-10-06 实测，两条链路都查了）。** 两个配置接口
> （`0xFF60/0x61`，**report ID 都是 9**）的报告描述符逐字节**只差 Report Count 一个数**：
>
> | 接口 | 差异字节 | Input | Output（载荷 / 上线） |
> |---|---|---|---|
> | 无线接收器 `0x106C` | `95 13` | 19 字节 | **19 / 20** |
> | 有线键盘 `0x103E` | `95 3f` | **63 字节** | **63 / 64** |
>
> ```text
> 无线: 06 60 ff 09 61 a1 01 85 09 09 62 15 00 26 ff 00 75 08 95 13 81 02 09 63 … 95 13 91 02 c0
> 有线: 06 60 ff 09 61 a1 01 85 09 09 62 15 00 26 ff 00 75 08 95 3f 81 02 09 63 … 95 3f 91 02 c0
> ```
>
> - 而 `setMusicDataV1` 走的是 **`sendReport(0, 32/64 字节)`** —— report id **0**，两个接口声明的
>   都是 **9**。所以这套 legacy 命令属于**别的机型**（同一个 `Yt` 表里还有 TFT 屏、点阵、
>   GIF 灯效、磁轴 DKS……本来就是覆盖多产品的 SDK）。
> - 枚举：接收器 10 个接口（`0x0001`×4 / `0x000C` / `0xFF02` / `0xFF03` / `0xFF04` / `0xFF05` / `0xFF60`）、
>   有线 7 个（`0x0001`×4 / `0x000C` / `0xFF00` / `0xFF60`）—— **两边都没有 `0xFF67`**：
>   厂商用来定位 legacy 设备的 `usagePage === 65383` 在本机上不成立。
> - 即便固件接受这套命令，**无线接收器的接口也只有 19 字节**，物理上装不下 32/64 字节的报告。
>
> ✅ 顺带两条收获：
> 1. 这条描述符**独立确认了 §4.1–4.5 的全部实现** —— 有线发 `[9]+63 字节`、无线发 `[9]+19 字节`
>    的 0x66 分片，恰好都是各自接口允许的极限。
> 2. **无线接口只收 19 字节这件事本身，就是"63 字节应用包由接收器自己重组"的直接证据** ——
>    主机交给它的永远只是分片。接收器有它自己的状态机，主机看不见也管不着（这也解释了
>    §4.5 那条通道"发射即忘、零回报"的根因）。

---

## 5. 宏 `IMacroService`

| 方法 | cmd | param | 入参 | 请求 data | 应答 data |
|---|---|---|---|---|---|
| `getMacroMaxStorageSize` | `0x82` | `0x00` | 无 | 空 | 4 字节大端 = 宏区总容量（**本机实测 4096 字节**） |
| `getMacroHeaderLength` | `0x85` | `0x00` | 无 | 2×`00` 占位 | ⚠ 见下：**本机固件对 2 字节请求不回数据**，这条不可用 |
| `getMacroHeaders(len)` / `getMacros` | `0x85` | `0x00` | 要读的字节数（`len` 个 `00` 撑出多包） | — | 区域原始字节；`0x85/0` 就是「按请求长度读宏区」 |
| `setMacros` | `0x05` | `0x00` | `[{name, actions:[{kind, category, delay, keycode}]}]` | 头部表 + 宏体；动作 4 字节 `[((kind&1)<<7)\|((category&7)<<4)\|((delay>>16)&15), (delay>>8)&255, delay&255, keycode]` | 无 |

**动作 4 字节的逐字段定义**（2026-10-06 用官方网页自己的 SDK 写一条已知宏、抓它的报文核对，
我们的编码器现已与厂商输出**逐字节相同**）：

| 位/字节 | 字段 | 取值 |
|---|---|---|
| byte0 bit7 | `kind` | SDK 枚举 `lg`：**0 = 按下，1 = 抬起** |
| byte0 bit4–6 | `category` | SDK 枚举 `a8`，**按键种类**：`0`=普通按键、`1`=修饰键(0xE0–0xE7)、`2`=鼠标、`3/4/5`=MouseX/MouseY/滚轮（后三者 SDK 只解不编） |
| byte0 bit0–3 + byte1 + byte2 | `delay` | 20 位毫秒（`0..0xFFFFF`），高位在 byte0 低 4 位 |
| byte3 | `keycode` | 1 字节键值；鼠标键是**位掩码**（左=1、中=4、右=2、后退=8、前进=16），不是按钮序号 |

> 🔴 **早先本文档把 bit4-6 写成「设备来源：0=键盘/1=鼠标/2=多媒体」——那是错的**，而且有实际后果：
> 把**修饰键**（0xE0–0xE7，如 Shift/Ctrl）编成 `category=0`（普通键），固件不认，
> 表现为"宏里的按下/抬起完全不触发"。修正后修饰键必须用 `category=1`。
> 官方前端里的 `device:"keyboard"|"mouse"` 是**解码端从 `category==2` 反推**的，
> **线上没有这个字段**，别照着它编码。

> **`0x85/0` 的正确用法与「头部表长度」**（2026-10-06 真机核对，**纠正了本文档早先的说法**）：
>
> `0x85/0` 是**按请求长度读宏区**：请求 N 个 `00` 就回 N 字节区域内容（多包时每包 `[1][2]` 注入该包偏移，
> 见下）。用 2 字节请求时本机返回**空数据**，所以早先记录的「回 2 字节 LE16 = 头部表长度」是**误读**
> （那 2 个 `00` 只是空应答的补零）。
>
> 头部表长度可以**从区域自身推出**：第一条表项的 `offset` 就是表长（SDK 里恒为 `4 × 宏条数`）。
> 空区首 4 字节是 `ff ff ff ff` ⇒ 没有宏。
>
> ```
> 区域布局（真机逐字节核对）：
>   [头表] N × 4 字节，小端 { offset LE16, length LE16 }，offset 从区域起点算
>   [宏体] 第 i 条在 offset 处：[nameLen][UTF-8 名][动作 × N]，动作 4 字节
>
> 实测样例（写 1 条宏 "T1"，2 个动作）：
>   04 00 0b 00 | 02 54 31 | 00 00 00 04 | 80 00 32 04 | ff ff ff …
>   └ 表项 ──┘  └ nameLen=2 "T1" ┘ └ 按下 A ─┘ └ 抬起 A 延时50 ┘ └ 擦除态 ┘
>   表项: offset=0x0004, length=0x000B   ← 小端；offset = 4×1 = 头表长度
> ```

**本机实测**：`0x82/0x00` → `00 00 10 00` = **4096 字节**；宏区与宏表在这台设备上可读可写
（2026-10-06 完整走通：读 → 写 1 条 → 读回逐字段一致 → 写空集 → 读回擦除态）。

### 5.1 前端（改键页「快捷指令」）实现了哪些

宏的 UI 在改键页（`key-CAVryEkN.js` + `index-hgKF_tct.js`）：

| 功能 | 状态 | 走哪条命令 |
|---|---|---|
| 宏列表读取 | ✅ | `0x85/0x00`（一把梭，不用 `getMacroHeaderLength`/`getMacroHeaders`） |
| 新建 / 编辑 / 删除 / 重命名 / 保存全部 | ✅ | `0x05/0x00`（整体回写） |
| 动作：键盘按键（含录制 keydown/keyup） | ✅ | 0x05 动作体 |
| 动作：鼠标按键（左/中/右键） | ✅ | 同上，`device='mouse'` |
| 动作：延时（每动作一个 `time`，最小 10 ms；另有"修改全部延迟"） | ✅ | 同上 |
| 动作：多媒体键 | ✅（以**键值**形式，不是独立动作类型） | 键码走媒体段 `0x02xxxxxx` |
| 循环方式 | ✅ 3 种：指定循环次数 / 重复直至任意键按下 / 按住重复松开停止 | 编进键码 `(3<<24)\|(loopType<<16)\|(loopCount<<8)\|idx` |
| 绑定到键 | ✅ | 单键 `0x03`（`keymap`） |
| 容量检查 | ✅ 超限弹窗；容量按 `4 字节/表项 + 4 字节/动作 + 名称字节数` 估算，缺省 `0x1000`（= **4096**，与设备实测一致） | `0x82/0x00` |

**前端未实现 / 设备侧有但没人用**：

- **文本宏**（`0x28` 写 / `0xA8` 读、定长槽位与变长区）：SDK 完整实现，**前端 0 引用**。
- 宏头/分片接口（`getMacroHeaderLength` / `getMacroHeaders`）：SDK 有，前端未用。
- **火力键 / 连发**：键盘侧没有该能力（只在鼠标类预览页出现）。
- 进阶宏启动模式（"再次按键结束 / 松开停止 / 点按播放"等 9 种文案）：只实现 3 种。

### 5.2 文本宏 `ITextMacroService`

| 方法 | cmd | param | 说明 |
|---|---|---|---|
| `writeFixedLengthTextMacro` | `0x28` | `槽号 + 1` | 定长槽位写入：`LE16(len) + 文本`（可打印 ASCII 与 `\t\n\r`），上限 `min(slotBytes-2, 65535)` |
| `readFixedLengthSlot` / `readFixedLengthTextMacro` | `0xA8` | `槽号` | 读回同结构 |
| `getFixedLengthTextMacros` / `setFixedLengthTextMacros` | – | – | 整组定长槽位的批量读写（内部走上面两条） |
| `getVariableLengthTextMacros` / `setVariableLengthTextMacros` / `readVariableLengthRegion` | – | – | 变长文本宏区 |
| `getCapability` | – | – | 读「设备能力」里的 `textMacroStorageSize` / `textMacroLength`（见 §1.1 能力块 `[14] [15]`） |
| 文本宏键（keycode） | – | – | `(0x12 << 24) \| (loopType << 16) \| (loopCount << 8) \| slot`，见 `keycodes.md` §1 |

循环方式（`validateLoop`）：`Count`（次数，≥1）与 `UntilKeyUp`（按住直到松开）；非法值会被 SDK 拒绝。

> 宏相关的包必须经 `buildMacroCommands()` 预处理：它把包内字节偏移写进 `[1][2]` 后重算 CRC。
> 直接手搓帧容易漏这一步。文本宏不需要这一步。
>
> ⚠ **写宏前必须整段读完宏区**（`aula_hid.read_macro_region()`）：设备会把"本次写入长度之外"的区域
> 置成 `0xff`（擦除态），只写回头部会把宏体擦掉。本项目实测踩过这个坑（丢掉一条 115 字节的宏）。
> 正确姿势：`region = read_macro_region(a)` → 改 → `macro_write_packets(region)` 整段写回。
>
> **写路径预处理已实现并实测**（`tools/aula_hid.py`）：
> `build_packets`（多包切分）、`inject_macro_offsets`（宏的偏移注入）、
> `inject_advanced_type`（高级键的 `[2]`=类型注入）——宏读写与高级键 TGL 写/删均已真机验证通过。
> 另：宏区是**按板载配置分开存**的（配置 0/1/2 各有一块）；高级键应答里**数据以 id 开头，类型在包内 `[2]`**（空槽为 `0xff`）。

---

## 6. 高级键 `IAdvancedKeyService`

改键页「高级键功能」页的 7 张卡片与协议类型的对应（文案取自页面）：

| 卡片（UI 文案） | 页面说明 | type（包内 `[2]`） | 入参 | 请求 data |
|---|---|---|---|---|
| **动态键程（DKS）** | 将一个按键根据按压和松开程度不同，绑定 1~4 种功能 | `3` | `{id, pressDepth{start,bottom,bottomRelease,fullRelease}, groups[{keycode,trigger{...}}]}` | `BE16(id)` + 4×`BE16`(深度) + N×( `BE32(keycode)` + 4×`1B`(触发段枚举) ) |
| **瞬间释放（SOCD）** | 同时按下两个按键时，根据预设快速触发指定按键 | `4` | `{ids[], responseMode?}` | `[count, …BE16(id), responseMode]` |
| **多点触控（MPT）** | 按下一次按键可以触发三次不同的输入 | `5` | `{id, groups:[{keycode, distance}]}` | `BE16(id) + [count] + N×(BE32(keycode)+BE16(distance))` |
| **按住/单击（MT）** | 单键可区分点击与长按，分别触发不同功能 | `2` | `{id, holdKeycode, clickKeycode, delay}` | `BE16(id)+BE32(hold)+BE32(click)+BE16(delay)` = 12 字节 |
| **切换开关（TGL）** | 单击按键可开关持续触发 | `1` | `{id, keycode, delay}` | `BE16(id) + BE32(keycode) + BE16(delay)` = 8 字节 |
| **终端跃迁（END）** | 单个按键在松开时触发另一个按键 | `6` | `{id, keycode}` | `BE16(id) + BE32(keycode)` = 6 字节 |
| **迅捷（RS）** | 同时按下两个按键时，触发按下键程更深的按键 | `7` | `{ids:[a,b]}`（必须 2 个） | 2×`BE16(id)` = 4 字节 |

UI 数值换算（前端实测）：DKS 的 `pressDepth` 与 MPT 的 `distance` 都是 **UI mm × 100**（0.01 mm 单位）；
TGL/MT 的 `delay` 是**毫秒原值**（默认 200）；`keycode` 取自键位表的 `browserValue`（见 `keycodes.md`）。

读写与删除：

| 方法 | cmd | param | 入参 | 说明 |
|---|---|---|---|---|
| `setAdvancedKey` | `0x12` | `ELS` | `{type, …}` | 按 `type` 分发到上表 |
| `deleteAdvancedKeyById` | `0x12` | `ELS` | `{id}` | data = `BE16(id)`（编辑前先删） |
| `getIdsOfAdvancedKey` | `0x92` | `ELS` | `{layer, system}` | 空 data；包内 `[3]`=总页数、`[4]`=页号（SDK 先固定 1，再用应答 `[5]` 反推翻页）；应答 = 每 2 字节一个 id |
| `getAdvancedKey` | `0x92` | `ELS` | `{id}` | data = `BE16(id)`；应答按 type 反向解析（类型在应答里） |
| `getAdvancedKeys` | `0x92` | `ELS` | `{layer, system}` | 先列 id 再逐个读详情 |

> 写高级键的包要经 `buildAdvancedKeyCommands(packets, type)` 预处理：它把 **type 写进每包的 `[2]`** 再重算 CRC。
>
> **`id` 就是承载该功能的物理键 id**（不是随便的槽号）——这解释了为什么列表里的 id 看起来"东一个西一个"。
>
> **本机实测（2026-10-06，整机出厂重置后）**：`0x92` 空 data 在一开始三层都返回**空列表**——
> 列表只包含**已有高级功能**的键。完整走通一遍（Fn 层，id 67）：
>
> ```
> 写 0x12 type=TGL: data = 00 43 00 00 00 04 00 C8        (BE16(67) + BE32(0x04) + BE16(200))
> 读 0x92 id=67  : 92 01 01 01 00 08 | 00 43 00 00 00 04 00 C8
>                  └cmd┘└param=1┘ │  └len┘  └ id ┘ └ keycode ┘ └delay┘
>                                └ 包内 [2] = type = 1 (TGL)
> 列表 0x92 空   : len=2, data = 00 43                    → 列表现在含 67
> 删 0x12 type=0 : 同上 data = 00 43
> 读回           : 包内 [2] = 0 (NONE) → 空槽；列表回到空
> ```
>
> 早先记录的「Fn/Fn1 层各 5 个 id」是重置前的历史状态，不是固定槽位数。

---

## 7. 触发与性能（磁轴键程 / RT / 死区 / 轴体）

### 7.1 命令

| 方法 | cmd | param | 入参 | 请求/应答 data |
|---|---|---|---|---|
| `setRapidTriggers` | `0x19` | `ELS` | `{layer, system, rapidTriggers:[{id, enable, sensitivity:{press, release}}]}` | 每条 8 字节：`BE16(id), enable, BE16(press), BE16(release), 0`（每包 ≤7 条） |
| `getRapidTriggers` | `0x99` | `ELS` | `{layer, system, ids:number[]}` | 请求每 id `BE16`（每包 ≤7）；应答**步长 8 字节**（有效字段 7）：`BE16(id), enable, BE16(press), BE16(release), 保留 1 字节` |
| `setKeyTravel` | `0x13` | `ELS` | `{layer, system, keys:[{id, travel}]}` | 每条 5 字节：`BE16(id), BE16(travel), 0`（每包 ≤11 条） |
| `getKeyTravel` | `0x93` | `ELS` | `{layer, system, ids:number[]}` | 请求每 id `BE16`；应答 5 字节/条，同 `0x13` || `setKeySwitchType` | `0x15` | `0x00` | `[{id, switchType}]` | 每条 3 字节：`BE16(id), switchType`（轴体 id，原值；每包 ≤18 条） |
| `getKeySwitchType` | `0x95` | `0x00` | `ids:number[]` | 应答 3 字节/条，同 `0x15` |
| `setSafeArea` | `0x16` | `0x00` | `[{id, topHeight, bottomHeight, enable}]` | 每条 8 字节：`BE16(id), BE16(top), BE16(bottom), 0, enable`（每包 ≤7 条） |
| `getSafeArea` | `0x96` | `0x00` | `ids:number[]` | 应答 8 字节/条，同 `0x16` |
| `getKeyAdRange` | `0x94` | `0x05` | `ids:number[]` | 请求每 id `BE16`（每包 ≤9）；应答 6 字节/条：`BE16(id), BE16(max), BE16(min)` |
| `startCalibration` | `0x94` | `0x00` | 无 | 轴体校准：SDK 内部 **每 1000ms 重发一次**（`setInterval`），并立刻先发一次 |
| `stopCalibration` | `0x94` | `0x04` | 无 | 结束校准并清掉轮询定时器 |
| （事件）`KeyCalibration` | `0x94` | `0x02` | – | 校准进度上报，见 §11.4 |
| （行程测试）start / stop | `0x98` | 见 §11.3 | 无 | SDK 同样是 **1000ms 轮询重发 Start**；设备回 `0x98/param=1` 上报，见 §11.3 |
| `getSleepInfoRaw` | `0x25` | `0x00` | 无 | 应答 3 字节：广播休眠档 / 重连休眠档 / 休眠档 |

**顶部/底部死区就是 `0x16/0x00`（写）与 `0x96/0x00`（读）**，不叫 "dead switch"——
SDK 里那个 `setTopDeadSwitch`（`ORDER_TYPE_TOP_DEAD_SWITCH`）属于鼠标/接收器那条线，键盘不用它。

### 7.2 UI 值 ↔ 协议整数换算（前端 `trigger-BGy4DZnH.js` 反推）

三条滑杆共用一套由**设备自报**的步进：

```
step  = getTravelPrecision() / 1000        // 0x82/0x08；本机实测 5 → 0.005 mm
fixed = step 的小数位数                     // 0.005 → 3
协议整数 = Number((UI_mm / step).toFixed(fixed))     // 0.13 / 0.005 = 26
UI_mm   = 协议整数 × step
rtMin   = getMinRapidTrigger() / 1000      // 0x82/0x06，单位 0.001 mm
```

| UI 项 | 协议字段 | 换算 |
|---|---|---|
| 顶部死区 / 底部死区（mm，0…0.5） | `0x16` 的 `top`/`bottom` | `mm / step`（0.13 → **26**、0.35 → **70**），BE16 |
| 按下/抬起灵敏度（mm，≥rtMin） | `0x19` 的 `press`/`release` | `mm / step`（0.005 → 1） |
| 单键行程（mm） | `0x13` 的 `travel` | `mm / step` |
| DKS 的 pressDepth、MPT 的距离 | `0x12` 内 | **×100**（0.01 mm 单位） |
| 轴体 id | `0x15` 的 `switchType` | 原值，不换算 |

> 注意系数**不是固定的 ×1000 或 ×200**，而是 `1/step`，由 `getTravelPrecision()` 决定；
> 本机读到 5（→ ×200）时 0.13 就是 26。

**本机实测（逐条与真机对照过）**：

```
0x82/0x08 行程精度 = 5     → step = 0.005 mm（系数 ×200）
0x82/0x06 最小 RT  = 5     → 0.005 mm
0x96/0x00 死区(id 1) = 00 1a 00 46 00 01 → top=26(0.13mm) bottom=70(0.35mm) enable=1   ← 与页面显示的 0.13/0.35 完全一致
0x93/ELS  触发点(id 1) = 00 c8 00       → travel=200 → 1.00 mm（按到 1.00mm 才触发）
0x95/0x00 轴体(id 1) = 08                 → switchType=8
0x99/ELS  RT(id 1)  = 00 00 00 00 00 00   → enable=0, press=0, release=0
```

> 🔴 **`0x13/0x93` 是「触发点（触发行程）」，不是「单键总行程」**（2026-10-06 用户实测纠正）。
> 它的值是**按键要按到多深才算触发**：调大 ⇒ 必须按得更深才触发（调到 1.71mm 就必须按很深）。
> 早期本项目在界面上把它标成"单键行程"，语义是错的，会让人以为在调行程上限。
> 界面上现在叫 **「触发点 / 触发深度」**，并注明"数值越大，需要按得越深才触发"。
> 另外注意别和**行程测试**（`0x98`）混淆：那个测的是按键**当前实际深度**。

### 7.3 UI 控件 ↔ 变量 ↔ 命令（触发页模板已抓到，逐条坐实）

| UI 文案（i18n） | 绑定变量 | 命令 / 行为 |
|---|---|---|
| 选择轴体 | `activeData.axisValue` | 选项 = 本地轴体表 ∩ `0x82/0x03` 位图 |
| 应用轴体 | – | `0x15/0x00`（无选中键时按钮禁用） |
| 行程测试 | `activeData.travelTest` | `0x98/Start` 起、`0x98/Stop` 停（1 Hz 轮询在 SDK 层） |
| 按下灵敏度 | `rtPress` | `0x19/ELS`（需选中键且 RT 总开关为开，否则置灰） |
| 抬起灵敏度 | `rtRelease` | `0x19/ELS` |
| 同步设置按下与抬起 | `togetherMode` | **无命令**（纯 UI 开关，只影响下一次滑杆改动；模板里连 `onChange` 都没有） |
| 顶部死区 | `dp` | `0x16/0x00` |
| 底部死区 | `dr` | `0x16/0x00` |
| 轴体校准 | `calibrationStatus` | `0x94/0x00` 起 / `0x94/0x04` 停，进度吃 `0x94/0x02` 事件 |
| 当前轴体（悬浮卡） | 键对象 `axisId` | `0x95/0x00` |
| RT按下 / RT抬起 / 行程（悬浮卡） | 键对象 `rtPress/rtRelease/singleTravel` | `0x99` / `0x93` |
| （无独立文案）单键行程滑杆 | `singleTravel` | `0x13/ELS` |
| （RT 总开关） | `triggerMode` | `0x19` 的 `enable` 字段 |
| **全行程快速触发** | `isWholeFast` | **无命令**——模板渲染了这个开关，但逻辑层没有对应字段/分支（空操作） |

滑杆 props（模板里直接可读）：

```
行程/灵敏度： max: travelMax ∥ 3.4, min: travelMin ∥ 0.1, steps: travelStep, fixed: travelFixed
死区：       max: dieMax ?? 1,    min: dieMin ?? 0,     steps: dieStep,   fixed: dieFixed
```

### 7.4 页面其它行为

- **轴体下拉** = 本地轴体表（`Bytech-BANinpeY.js`，47 项 `{label, id, maxTravel, iconColor}`）
  **∩** 设备位图 `0x82/0x03`；「应用轴体」走 `0x15/0x00`，之后用 `0x95/0x00` 刷新每键轴体。
- **「同步设置按下与抬起」不是协议字段**，是纯前端开关：打开时改一个灵敏度会自动同步另一个并同时下发两条。
- **行程测试**的刷新率 ≈1 Hz（轮询在 SDK 层），页面自己不轮询。
- **每包条数规则**：`perPacketMax = floor(56 / 应答记录字节) × 应答记录字节`；
  请求侧用 `calculateAlignedDataSize(请求字节/条, 应答记录字节) = floor(56/记录字节) × 请求字节/条`。

---

## 8. 屏幕 `IDisplayService`

| 方法 | cmd | param | 入参 | 请求 data | 应答 data |
|---|---|---|---|---|---|
| `getLegacyDisplaySupport` | `0x82` | `0x0c` | 无 | 空 | 1 字节位图（0=LCD，1=LED） |
| `updateTime` | `0x0b` | `0x00` | `Date`（默认当前） | 14 字节：`[0,0,0, year LE16, month, day, hour, min, sec, weekday, 12,12,12]`（month 1-12，weekday 0=周日） | 无 |

---

## 9. 文本宏 `ITextMacroService`

| 方法 | cmd | param | 入参 | 请求 data |
|---|---|---|---|---|
| `writeFixedLengthTextMacro` | `0x28` | `i+1`（槽号+1） | `(i: 0..254, macro:{text}\|null, cap)` | `LE16(len) + ASCII/UTF-8 文本`（可打印 ASCII 与 `\t\n\r`），长度 ≤ `slotBytes-2` |
| （读回）`readFixedLengthSlot` | `0xA8` | 槽号 | 槽号 | 同 `0x28` 结构 |

---

## 10. 重置 `IResetService`

| 方法 | cmd | param | 入参 | 请求 data |
|---|---|---|---|---|
| `reset` | `0x11` | `ELS` | `{layer?, system?, type: 0..3}` | `[type]`：0=全局、1=按键、2=灯光、3=USB |
| `resetKeyboard` / `resetKeymap` / `resetLighting` / `resetUSB` | `0x11` | `ELS` | 同 `reset` | 依次 `type=0/1/2/3` |

> 另一套面向鼠标/接收器的重置是 `cmd=0x0F`（param 255/1/8/16 = 全局/按键/DPI/灯光），与键盘 `0x11` 不是同一条命令。

---

## 11. 设备主动上报（事件）

异步上报的命令字是 `cmd ∈ {0xFE, 0x98, 0x94}`，**不要**当应答处理。
判据（SDK `isBubbleResponse`）：`cmd ∈ {0xFE, 0x98, 0x94}` 且 `param` 匹配——
`0xFE` 任意 param、`0x98` 需 `param = Read(0)`、`0x94` 需 `param = 2`。

### 11.1 包头

事件包**不使用 6 字节信封**，只有 2 字节头，数据从偏移 2 开始：

| 偏移 | 含义 |
|---|---|
| 0 | `cmd`（0xFE / 0x98 / 0x94） |
| 1 | `param` = 事件类型 |
| 2… | 事件数据 |

帧层完全相同（19 字节帧、report id 9、和校验），**收到后仍需回 ACK**。

实测（`capture/hidlog-initial.txt`）：

```
66 85 01 0e | fe 05 61 10 00 … | 6e     cmd=0xFE, param=5, 电量 0x61=97%, 状态 0x10=充电中
```

### 11.2 `cmd = 0xFE` 事件表（SDK `onCommonBubbleResponse`）

| param | 事件 | 数据 |
|---|---|---|
| 2 | `DeviceDongleConnectChange` | `[2]`≠0 = 已连接 |
| 5 | `BatteryChange` | `[2]`=电量 %、`[3]`=状态位（高 4 位=充电中，低 4 位=充满） |
| 7 | `SystemChange` | `[2]`=值 |
| 9 | `ProfileChange` | `[2]`=当前配置序号 |
| 11 | `LightingEffectChange` | `[2]`=灯区+属性编码、`[3]`=值；属性为 `color` 时 `[4][5][6]`=R,G,B |
| 14 | `FunctionStatusChange` | `[2..3]` BE16 位域：bit0 Win 键锁、bit1 WASD 互换、bit2 全键锁、bit3 侧灯同步 |
| 其它 | – | SDK 不处理（返回 undefined） |

`param = 11` 的 `[2]` 编码表（`X2e` + `mZ`）：

| `[2]` 取值 | 灯区 | +0 | +1 | +2 | +3 | +4 |
|---|---|---|---|---|---|---|
| 1–5 | 主灯 Main | `effectId` | `brightness` | `speed` | `color` | `direction` |
| 6–10 | 侧灯 Side | 同上 | | | | |
| 11–15 | Logo | 同上 | | | | |
| 35–39 | 灯箱 Lightbox | 同上 | | | | |

例如 `[2]=3` → 主灯亮度，`[3]` 即亮度值；`[2]=4` → 主灯颜色，`[3]`=`colorIndex`、`[4..6]`=RGB。

> ⚠ **事件里的字段顺序与命令 param 不是同一套编号**（命令侧：`base+1`=效果 id、`+2`=颜色、`+3`=亮度、`+4`=速度，见 §4.1）。
> 事件用的是上面这张表（`effectId, brightness, speed, color, direction`）。

### 11.3 `cmd = 0x98`：键程实时上报（磁轴）

> **2026-10-06 真机纠正**：这一节的早先版本说「param = 0、数据从偏移 2 起」——**两处都不对**。
> 实测（有线 HERO 68 XS，`0xAA` 无关，走 63 字节应用包）：
>
> | 用途 | param | 数据 | 说明 |
> |---|---|---|---|
> | 监测**全部**键（设备自选集合） | `0` | 空 | 会起流 |
> | 监测**指定键** | `1` | `BE16 id × N`（≤28 个） | **只报这些键**，推荐 |
> | 停止 | `2` | 空 | |
>
> 🔴 **`0x98/0x01` 是一次快照，不是流**（2026-10-06 逐 100ms 分桶实测，纠正了本文档早先的说法）：
> 每发一次 Start，设备**只回一条**含所有被监测键的报文，然后**彻底安静**——
> 不重发时只有最初那 3 条，之后 **3 秒一条都没有**；每 500ms 重发就只在每次重发时各来 3 条。
>
> **所以"重发频率 = 采样率"**，早期把它当"保活"、500ms 重发一次，等于 500ms 的采样周期
> （界面上的表现就是按键后明显延迟）。设备其实完全跟得上快节奏重发：
>
> | 重发节奏 | 实测采样 |
> |---|---|
> | 每 2ms | 314 次/秒，1887 条/2s，0 个 100ms 空档 |
> | 每 1ms | 462 次/秒，2772 条/2s |
> | 全速忙轮 | **994 次/秒，5796 条/2s（3 键 ≈2900 条/秒）** |
>
> 上限就是设备自己的 ~1kHz，每一发都会被回答。**结论：重发要贴着火控节奏走**（本项目前端
> 每一轮 UI tick 都重发，约 250 次/秒、延迟约一个 tick）。

`param = 1`，数据区按 **6 字节/条**解析（SDK `onKeyTravelMonitor`），事件名 `KeyTravelMonitor`：

| 记录内偏移 | 含义 |
|---|---|
| 0–1 | `id`（BE16，键编号） |
| 2–3 | `distance`（BE16，当前行程） |
| 4–5 | BE16：bit15=`press`(按下)，低 15 位=`ad`(模拟量) |

### 11.4 `cmd = 0x94` / `param = 2`：轴体校准进度

事件名 `KeyCalibration`，数据区按 **6 字节/条**：

| 记录内偏移 | 含义 |
|---|---|
| 0–1 | `id`（BE16） |
| 2–3 | BE16：**bit15 = `finished`（该键校准完成）**，低 15 位 = `ad`（当前采样值） |
| 4–5 | BE16：`min`（该键的下限） |

> ⚠ **bit15 的极性最初写反了**（2026-10-06 从 SDK 的 `onKeyCalibration` 反推修正）：
> ```js
> const f = (c & 32768) === 0;    // press
> const h = (c & 32768) !== 0;    // finished   ← 网页按这个给按键染色
> ```
> 即 **bit15 置位 = 校准完成**（`press` 是它的反）。注意**同一位在 `0x98` 行程流里的含义是
> 「按下」**（`press = !!(ad & 32768)`），两者不是一套，别混用。

页面的进度 = `(adMax − ad) / (adMax − adMin) × 100`（`Math.max(0, …)`），
`adMax/adMin` 来自 `0x94/0x05`（`getKeyAdRange`）。

> **2026-10-06 真机实测（已确认）**：
>
> - 校准**确实会持续上报**，但必须**每 1 秒重发一次 `0x94/0x00`**；实测 15 秒收到 **242 条 `param=2`**，
>   节奏约 16 条/秒（前 1 秒只有那条空应答，第 2 秒才起量）。
>   ⚠ **2026-10-06 复测补充**：设备**只有真正进入校准状态时才上报**。同一条命令按 1 秒甚至
>   每轮重发、连续跑 2 秒，样本数都是 **0**——所以 `0x94` 与 `0x98` 不同，它**不是**"发一次回一次"的
>   快照。若界面在校准期间收不到数据，先确认设备确实在等按键（网页端进校准后键盘会有全键底色）。
> - 报文也是**标准 63 字节信封包**（和 `0x98` 一样，不是 2 字节事件头），校验同样满足 `≡ 0xF6`：
>
>   ```
>   94 02 00 01 00 06 | 00 01 85 68 05 65 | 00…
>   └cmd┘└param=2┘ │  └len┘  └ id ┘ └ ad/press ┘ └ min ┘
>                 └ 总包数=1 / 包号=0
>   ```
>   该样本解出来是 `id=1, press=1, ad=0x0568(1384), min=0x0565(1381)`。
> - 进/出校准由固件自己控制（网页用**标准键位模型**显示：每键显示实时数值，`finished` 的键染上颜色）——
>   主机命令只负责起停 + 读进度，**不要指望键盘本身亮灯表示进度**（实测键盘无灯光反馈）。
> - 实测设备**一次只报正在校准的那几个键**，每个键先来 1 条 `finished=0`，之后转成 `finished=1`：
>   6 秒 93 条样本覆盖 8 个键（`42,43,55,56,57,67,68,69`，每次运行集合不同）。
> - 停止用 `0x94/0x04`，发完就安静（实测停止后再收 0 条）。

### 11.5 另一套「dongle report」

19 字节且 `[0] === 0x0A` 的是鼠标/接收器那套的上报（SDK `isDongleReport` 判据），
其中 `[4] === 2` → `DeviceDongleConnectChange`，`[5]`≠0 = 已连接。

### 11.6 客户端处理建议

1. 主循环里按 `cmd` 先判事件：`cmd ∈ {0xFE,0x98,0x94}` → 走事件分发，不当作本次请求的应答；
2. 其余帧则要求 `frameIndex` 连续且第 1 片 `cmd/param` 与请求一致；
3. **无论哪种，每收到一帧都要立刻回 ACK**，否则设备不再继续下发。

参考实现已内置解析：`aula_hid.is_event(app)` / `aula_hid.parse_event(app)`（输入 63 字节应用包，返回事件字典）。

---

## 12. 鼠标 / 接收器侧（另一套命令）

同一接收器还有面向鼠标的命令字，字段布局与键盘不同，供参考：

| 方法 | cmd | param | 应答 data |
|---|---|---|---|
| `getMouseKey` | `0x23` | `0x00` | `[0]`=消抖；从 `[8]` 起 6 组×4 字节：`[0]`=按键类型（1=鼠标键→`code,times,gap`；3=宏键→`macroType,macroTimes,macroIdx`；其它→3 个 code） |
| `getSleepInfoRaw` | `0x25` | `0x00` | 3 个休眠档位 |
| `resetMouseKey`/`resetDpi`/`resetLight` | `0x0F` | 1 / 8 / 16 | 无 |
| `queryDeviceInfoCmd` 等 | 见 `[Wireless8K]` 之外的另一套 `config`（`generateCRC`/`WPpackets`） | | |

---

## 附录 A：枚举与取值范围

| 名称 | 值 |
|---|---|
| 轮询率档位 | 0=1K, 1=500, 2=250, 3=125, 4=8K, 5=4K, 6=2K |
| 消抖模式 | 0=Normal, 1=Leading, 2=Trailing, 3=Auto |
| layer | 0=Normal, 1=Fn1, 2=Fn2, 3=Tap |
| system | 0=Windows, 1=macOS |
| 高级键类型 | 1=TGL, 2=MT, 3=DKS, 4=SOCD, 5=MPT, 6=END, 7=RS |
| 重置类型 | 0=全局, 1=按键, 2=灯光, 3=USB |
| 灯光效果 id | 0..18 预置，19=自定义(CustomMode) |
| 灯区基址 | 主灯 1 / 侧灯 6 / Logo 11 / 灯箱 35 |
| RGB565 | `((r>>3)<<11) \| ((g>>2)<<5) \| (b>>3)`，大端 |

## 附录 B：源码定位

| 内容 | 位置（`tools/deobf-vendor/deobf-strings.js`） |
|---|---|
| 应用包 config（63/6/1/0/1/3/4/5/62） | 53958 |
| `encode` / `buildCommands` / `setChecksum` / `calculateCrc` | 53996 / 54179 / 54335 / 54341 |
| 链路层 `buildFrame`/`splitFrame`/`parseFrame`/`buildAckFrame`/`sendAndWaitAck` | 64244 / 64265 / 64030 / 64431 / 64073 |
| `IBaseService` 实现 | 58665 起 |
| `ILightingLegacyService` 实现 | 59777 起 |
| `IKeymapService` / `IConfigService` | 55549 起 / 58288 起 |
| 宏 / 高级键 / 性能 | 56367 起 / 56947 起 / 58038 起 |

> 说明：`deobf-strings.js` 里的字符串索引已被还原（`mZ`、`X2e`、`AM` 等表都能直接读），
> 但仍保留混淆器生成的 helper 名字（如 `o["icxFU"]`）；**cmd/param 与布局以本表为准**，
> 读类命令均已与真机报文对照。
