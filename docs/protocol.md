# AULA HUB 设备协议 (8K 无线接收器 / 键盘)

本文是 AULA HUB 网页驱动所用有线/无线配置通道的完整协议说明，目标是**不依赖官方网页即可读写设备**。
协议由三部分组成：HID 报告层 → 链路帧层 → 应用包层。

- 逆向对象：`https://hub.aulacn.com` 页面驱动 + 其内嵌 SDK（`vendor-ROqIirej.js` 中的 `[Wireless8K]` 传输层与 `protocol` 应用层）
- 结论来源：网页端 `sendReport/inputreport` 抓包（`capture/`）、设备实测（本机 USB 接收器）、SDK 还原源码（`tools/deobf.js` → `tools/deobf-vendor/deobf-strings.js`）
- 参考实现：`tools/aula_hid.py`（Python + hidapi），已实测可用

---

## 1. 设备与接口

| 项 | 值 |
|---|---|
| VID / PID | `0x372E` / `0x106C`（"8K Wireless Receiver" 接收器） |
| 配置接口 | `usage_page = 0xFF60 (65376)`, `usage = 0x61 (97)`（即 MI_02 Col01） |
| Output report ID | `9` |
| Input report ID | `9` |
| 单次报告长度 | 20 字节 = 1 字节 report ID + 19 字节帧数据 |

键盘/鼠标/consumer 接口（MI_00、MI_01）与该协议无关，枚举时必须按 `usage_page/usage` 过滤：

```python
import hid
VID, PID, USAGE_PAGE, USAGE = 0x372E, 0x106C, 0xFF60, 0x61
path = [d['path'] for d in hid.enumerate(VID, PID)
        if d['usage_page'] == USAGE_PAGE and d['usage'] == USAGE][0]
dev = hid.device(); dev.open_path(path)
```

> 浏览器（WebHID）与 hidapi 可以**同时**打开同一个接口；网页开着不影响自己的程序收发（实测）。

---

## 2. 链路帧层（19 字节帧）

> **适用范围**：本节是 **8K 无线接收器（`PID 0x106C`）** 这条链路。
> 有线键盘与普通 2.4G 接收器**不用这套帧**——它们把 63 字节应用包**整包作为一次 HID 报告**发出，
> 没有 `0x66` 帧、没有逐帧 ACK。三种链路的对照见 §2.4。

所有收发都是同一种帧结构：

| 偏移 | 长度 | 含义 |
|---|---|---|
| 0 | 1 | 固定魔数 `0x66` |
| 1 | 1 | `totalFrames`(1..127) \| `syncFlag bit2 << 7` |
| 2 | 1 | `frameIndex`(1..totalFrames) \| `syncFlag bit1 << 7` |
| 3 | 1 | `payloadLen`(0..127) \| `syncFlag bit0 << 7` |
| 4 | payloadLen | 负载 |
| 4+payloadLen | 1 | `checksum = sum(frame[0 .. 4+payloadLen-1]) & 0xFF` |
| … | 补 0 | 补齐到 **19 字节**后再作为 report id 9 的报文发出 |


`syncFlag` 是 3 位滚动序号（`0..7`，每帧 +1 回绕），编码在三个长度字段的最高位上：

```
syncFlag = ((b[1] & 0x80) >> 5) | ((b[2] & 0x80) >> 6) | ((b[3] & 0x80) >> 7)
```

主机侧自行产生（SDK 上电从 0 开始递增），接收方在 ACK 里原样镜像。**实测设备不校验该值**：主机从任意值起始都能正常通信，自己实现时按 +1 递增即可。

### 2.1 分片规则

| 方向 | 待发送数据 | 分片（payloadLen） |
|---|---|---|
| 主机 → 设备 | `0x09`(report ID) + 63 字节应用包 = **64** 字节 | 14, 14, 14, 14, 8 |
| 设备 → 主机 | 63 字节应用包 | 14, 14, 14, 14, 7 |

每片 payload 上限 14 字节（SDK 中 `validDataSize = maxByteSize-1-4-1 = 20-1-4-1 = 14`），
`totalFrames = 5`、`frameIndex = 1..5`。最后一片不足 14 字节时负载照常写，帧本身补零到 19 字节。

> 注意：主机方向的 64 字节里那个 `0x09` 就是 report ID。它既出现在 HID 报文头部，也参与应用层校验和计算（见 §3.2），所以分片时会把它当作负载的第 0 字节。

### 2.2 ACK 规则

接收方对**每一个**收到的帧都要回一个 ACK 帧：

```
ACK = [被确认帧[0], 被确认帧[1], 被确认帧[2], 被确认帧[3] & 0x80] + checksum(前 4 字节)
```

也就是复制前 3 字节、清掉长度低 7 位（保留 bit7 的 syncFlag 位）、长度记为 0、重算校验和。

设备对主机每个分片回 ACK；**主机也必须对设备发来的每一帧回 ACK**——这是最容易踩的坑：只发不收 ACK 时，设备只会回分片 ACK 而**不会下发数据**。

### 2.3 时序

SDK 的行为（`sendAndWaitAck`）：逐帧发送并等该帧的 ACK，超时后重试；源码里的默认值是
`timeout: 100 ms / retries: 10`，但页面运行时实际用的是 `timeout: 2000 ms / retry: 3`（`transport.options` 实测）。
自己实现建议 1~2 秒超时、重试 2~3 次即可。
它按 `totalFrames` 顺序发完 5 片，随后进入应答接收。实测的完整一次读写：

```
TX 66 05 01 8e | 09 87 00 00 01 00 00 … | 8b     ← 应用包第 1 片
RX 66 05 01 00 | 6c                               ← 设备 ACK 第 1 片
TX 66 05 02 8e | 00 …
RX 66 05 02 00 | 6d
TX 66 05 03 0e | 00 …                              （依次到第 5 片）
RX 66 05 05 00 | 70
RX 66 05 01 0e | 87 00 00 01 00 02 63 10 … | f7   ← 应答数据第 1 片
TX 66 05 01 00 | 6c                               ← 主机 ACK 应答第 1 片
RX 66 05 02 0e | 00 …
…
```

要点：

- 收到任何帧（不管是不是本次请求的应答）都应立刻回 ACK，设备才会继续下发后续分片。
- 设备会**主动上报**事件（见 §4.1），可能与应答交错，需要按 `cmd/param` 过滤。
- 客户端应带重试（一次请求失败后重发整包）。

### 2.4 三种链路：有线 / 2.4G 接收器 / 8K 无线

**应用层（§3 的 63 字节包、所有 cmd/param）在三种链路下完全相同**，差别只在**怎么把包送出去**。
选择哪条链路只由一件事决定：**`productId === 0x106C`**（SDK 里 `eKe = new Set([4204])`，`isWireless8K()`）。

| 维度 | 有线键盘 / 普通 2.4G 接收器 | **8K 无线接收器（`0x106C`，本文实测设备）** |
|---|---|---|
| 传输类 | `rxe` | `ZBe` → `JBe` |
| 发送方式 | `sendReport(reportId, pkt63)` —— **整包一次发出** | 前缀 reportId → 64 字节 → 按 14 字节分片 → **19 字节 `0x66` 帧逐帧发** |
| 链路头/校验 | 无额外头；校验就是应用包第 62 字节 | 每帧 4 字节头 + `Σ mod 256` 帧校验 |
| 分片 | 应用包内部 56 字节/包（多包=多次 sendReport） | 先 56 字节/包，再 14 字节/帧（5 帧/包） |
| ACK | 无帧级 ACK，靠"命令级等应答" | **每帧 ACK**（`length=0` 的 `0x66` 帧） |
| 超时/重试 | 1000 ms / 1 次（`rxe` 默认 500/3） | 帧级 100 ms / 10 次；命令级 2000 ms / 3 次 |
| reportId | `Y2e(device)`：取同时含 input/output report 的 collection 的 output reportId | 同上 |

**有线链路已真机实测**（HERO 68 XS，`PID 0x103E`，USB 线连接）：

- HID 描述符直接给出答案：配置接口（`usage_page 0xFF60` / `usage 0x61`）里
  **`Report ID (9)`、input/output report 各 63 字节** —— 一次报文正好装下整个应用包，**没有帧头的空间**。
- 实测收发（电量查询）：

  ```
  TX 09 | 87 00 00 01 00 00 00 …(63B, crc=6e)
  RX 09 | 87 00 00 01 00 02 64 10 00 …(63B, crc=f8)      → 电量 0x64=100%，0x10 充电中
  ```

- 结论：有线 = **63 字节应用包整包直发**，无 `0x66` 帧、无逐帧 ACK、无需分片（多包时逐包发）。
- `tools/aula_hid.py` 已自动识别链路：`PID == 0x106C` 走分帧，否则走直发（见 §5）。

**第三条通道：`*ByWireless` 裸报文**（灯光专用，绕过应用包与 `0x66` 帧，直接 `sendReport(9, 19字节)`）：

```
[0x08, total, index, (type<<4)|len, data(≤13), 0x00…补齐, crc]
crc = 255 - ((9 + Σpayload) mod 256)          type: 1=按键 id 的 RGB, 2=全键单色, 3=灯珠
```

它编码的**逻辑命令与有线版一致**（`cmd=8`，`param`=type），所以是"同一命令的轻量投递通道"，
而不是另一代协议；SDK 里 `updateLedBeadColorsByWireless` 直接抛
`"Not implemented yet, please use updateRGBWithLedBeadsByWireless or updateRGBByWireless instead"`，
说明**裸报文版是较新、被推荐的那条**。本机 8K 接收器上是否接受未实测。

**`0x0A` 开头的 19 字节报文**是接收器状态上报（同一条 HID 输入接口上按首字节区分）：
`byte0=0x0A`、`byte4=0x02`（子类型=连接变化）、`byte5`=连接状态（1=已连接）→ 事件 `DeviceDongleConnectChange`。
它不参与分帧/ACK。其余字节含义未确定。

**别混用两种 "wireless"**：

- 前端设备目录里的 `wireless: 1` 是**静态标记**（一大批 dongle 都带），只影响 UI（无线徽标/电量显示/升级提示）。
- SDK 的 `isWireless8K`（只看 `PID 0x106C`）才决定**走不走 `0x66` 分帧**。

**有线/无线在功能上的实际差异**（前端实测，均不在触发页）：电池显示只在线；性能页的低功耗/休眠只在线读；
有线**不支持固件升级**（提示改用接收器）；有线且桌面版才多一个「实时 GIF 灯效」页签；
连接文案 `有线连接 / 无线连接`。触发页本身**没有任何有线/无线分支**。

**UUID 识别**：命令相同（`0x82/0x01`，`retry:0`，按 transport 缓存），无线时只是被包成 `0x66` 帧。
前端对 8K 接收器**强制用 Wireless8K 通道读 UUID**，再用 UUID 反推接收器背后的机型
（本机 UUID `0x120000000010`）。

---

## 3. 应用包层（63 字节信封）

### 3.1 字段布局

SDK 中的定义（`config`）：

```js
{ totalPacketSize: 63, headerLength: 6, tailLength: 1,
  commandIdIndex: 0, commandParamIndex: 1,
  totalPacketLengthIndex: 3, currentPacketIndex: 4,
  lengthIndex: 5, checksumIndex: 62 }
```

| 偏移 | 长度 | 含义 |
|---|---|---|
| 0 | 1 | `commandId`（命令字） |
| 1 | 1 | `commandParam`（子命令/参数） |
| 2 | 1 | 保留，恒为 0 |
| 3 | 1 | `totalPackets`（本次消息的总包数，单包为 1） |
| 4 | 1 | `currentPacket`（当前包序号，从 0 开始） |
| 5 | 1 | `dataLength`（本包数据字节数，单包最大 **56**） |
| 6 | 56 | 数据 |
| 62 | 1 | 校验字节 |

`validDataLength = totalPacketSize - headerLength - tailLength = 63 - 6 - 1 = 56`

### 3.2 校验和

SDK 的 `calculateCrc`：把第 62 位置 0 后累加，返回 `255 - (sum % 256)`，累加初值为 **9**（report ID）。等价写法：

```
crc = 255 - ((9 + Σ packet[0..61]) mod 256)
```

即 **`Σ([0x09] + packet[0..61] + [crc]) == 0xFF`**。这条规则对主机请求和设备应答都成立，可直接用它验证任意帧是否合法。

### 3.3 请求 / 应答

- 请求：`commandId`/`commandParam` 指定操作，`dataLength` 为参数长度（无参数则 0）。
- 应答：设备把 `commandId`/`commandParam` **原样回带**，数据从偏移 6 开始。
- ⚠ **`dataLength`（偏移 5）对读命令不可靠**：很多命令设备照发数据但该字段填 `0`
  （实测 `0x82/0x03`、`0x82/0x09`、`0x90` 都是 `len=0` 却带数据；`0x87`、`0x82/0x0d` 则正常填 1~2）。
  原厂 SDK 的做法是 `decode(packet, n)` **按命令固定长度硬读**，直接覆盖长度字段。
  自己实现时请按 `docs/commands.md` 里每条命令的应答长度取数据，**不要**用 `dataLength` 判断"有没有数据"。
- 大数据（如键盘布局、宏区）用多包：`totalPackets > 1`，每包 `currentPacket = 0..N-1`，
  每包独立拆成 5 帧发送，各帧继续使用同一个滚动 syncFlag；客户端要把 `dataLength` 声明有效的**各包数据**按序拼接。
- **例外：设备主动上报包不用这个信封**，只有 2 字节头 `[cmd][事件类型]`，数据从偏移 2 起（见 `commands.md` §11）。

---

## 4. 命令总览

逐条命令参考（功能 / cmd / param / **参数个数与取值范围** / 请求与应答的字节布局）见
[`commands.md`](commands.md)。本节只放总览。

`cmd`/`param` ↔ SDK 方法名的对应关系由 `protocol.encode(cmd, param, data)` 调用点提取（`tools/cmdtable.py`）；
带 `✓` 的方法已在真机上实调通过。

| cmd | 方向 | 用途 |
|---|---|---|
| `0x01` | 读 | 设备基础信息（版本 / UUID / 连接状态 / 电量 / 最大 DPI / 宏容量） |
| `0x03` | 写 | 键位映射（批量，每条 6 字节） |
| `0x04` | 写 | 整块设置：OS 模式、休眠、Win 锁、轮询率、消抖、低功耗、WASD 互换、侧灯同步、灯光效果（param 区分） |
| `0x05` | 写 | 整段宏区 |
| `0x06` | 写 | 主灯自定义逐键灯效 |
| `0x08` | 写 | 灯光：全键单色 / 色组 RGB / 灯珠 / 灯珠色组（param 区分） |
| `0x0b` | 写 | 同步时间（屏幕） |
| `0x11` | 写 | 重置：0=全局、1=按键、2=灯光、3=USB |
| `0x12` | 写 | 高级键写入（包内 `[2]` 区分 TGL/MT/DKS/SOCD/MPT/END/RS） |
| `0x19` | 写 | 快速触发（磁轴） |
| `0x1a` | 写 | 配置文件名称 |
| `0x22` | 写 | 特殊键（滚轮 / 滑条功能） |
| `0x28` / `0xa8` | 写 / 读 | 文本宏槽位 |
| `0x29` | 写 | 灯箱矩阵 RGB（param 3） |
| `0x82` | 读 | 设备静态信息与能力位图（param 选子项，见 `commands.md` §1.1） |
| `0x83` | 读 | 键位映射（批量，每包 9 条） |
| `0x84` | 读 | 设置与灯光状态（param 与 `0x04` 一一对应） |
| `0x85` | 读 | 整段宏区 |
| `0x86` | 读 | 主灯自定义逐键灯效 |
| `0x87` | 读 | 电量与充电状态 |
| `0x90` / `0x9a` | 读 | 当前配置序号 / 配置名称 |
| `0x13` / `0x93` | 写 / 读 | 单键触发行程（磁轴，5 字节/条） |
| `0x15` / `0x95` | 写 / 读 | 键位轴体类型（3 字节/条） |
| `0x16` / `0x96` | 写 / 读 | 顶部/底部死区 + 使能（8 字节/条） |
| `0x19` / `0x99` | 写 / 读 | 快速触发 RT（写 8 字节/条，读步长 8） |
| `0x92` / `0x94` / `0xa1` / `0xa2` / `0xa5` | 读 | 高级键列表 / 键程范围与校准 / 灯珠坐标 / 特殊键 / 键位矩阵坐标 |
| `0x98` | 上报 | 磁轴键程实时上报（`Start`/`Stop` 由主机侧轮询触发） |
| `0xfe` `0x98` `0x94` | 事件 | 设备主动上报，见 §4.1 |

读与写的 `param` 基本对称：`0x84/<n>` 读、`0x04/<n>` 写同一项设置（n = 17 系统模式、19 休眠、21 Win 锁、
23 轮询率、29/30 消抖、32 低功耗、33 WASD 互换、34 侧灯同步…）。

### 4.1 设备主动上报（事件）

SDK 把命令字 `0xFE`、`0x98`、`0x94` 列为异步上报（`bubbleCommandIds: new Set([254, 152, 148])`），
收到时**不要**当作请求应答。事件名（`commandParam` → 事件）包括：
`BatteryChange`、`ConnectChange`、`ProfileChange`、`DPIChange`、`ReportChange`、`LightChange`、`LODChange`、`KeyTravelMonitor`、`LightingEffectChange`、`FunctionStatusChange`、`SystemChange`。

实测样例（取自 `capture/hidlog-initial.txt`，未请求时收到）：

```
66 85 01 0e | fe 05 61 10 00 … | 6e     cmd=0xFE param=0x05, 0x61=97% / 0x10 充电中
```

即 `0xFE` 包的参数区直接是「电量百分比 + 状态位」。事件包的完整布局**未确定**，见 `commands.md` §11。

处理建议：主循环里按 `cmd` 过滤，只把 `cmd == 本次请求的 cmd && param == 本次请求的 param` 的包当作应答，其余帧仍要回 ACK。

---

## 5. 参考实现

`tools/aula_hid.py`（约 190 行，仅依赖 hidapi）：

```python
from aula_hid import Aula, build_app_packet, read_battery, read_device_info

a = Aula(); a.open()
print(read_device_info(a))    # 0x82/0x01
print(read_battery(a))        # {'level': 99, 'flags': 16, ...}
a.close()
```

发送任意命令并取数据区：

```python
from aula_hid import Aula, build_app_packet, read, packet_data

a = Aula(); a.open()
print(read(a, 0x84, 23, 1).hex())          # 轮询率(1 字节)
print(read(a, 0x82, 0x03, 8).hex())        # 支持的开关位图(8 字节)
pkt = a.exchange(build_app_packet(0x90, 0x00))
print(packet_data(pkt, 1)[0])              # 当前配置序号
a.close()
```

> `read(a, cmd, param, size)` 的第 4 参是该命令的**应答长度**（见 `docs/commands.md`）。
> 不要用包内 `dataLength` 判断有没有数据 —— 很多读命令设备填 0 却照发数据（§3.3）。

解析设备主动上报（电量变化、灯光变化、磁轴键程…）：

```python
from aula_hid import Aula, is_event, parse_event
...
pkt = a.exchange(build_app_packet(0x84, 1))     # exchange 已过滤掉事件
if is_event(pkt):                               # 若是事件(自建读循环时用)
    print(parse_event(pkt))                     # {'event': 'BatteryChange', 'level': 97, ...}
```

命令行直接发一条命令并 dump 原始帧：

```bash
python tools/debug_rx.py 0x84 23
```

> **两种链路都支持吗**：`Aula.open()` 会读设备 PID 自动判断——
> `PID == 0x106C`（8K 无线接收器）走 **`0x66` 分帧 + 逐帧 ACK**（§2）；
> 其它（如有线 `0x103E`）走 **63 字节应用包整包直发**（§2.4），两条路都已真机实测。
> 想强制指定可以 `a.open(pid=0x106C)` 或 `Aula(pid=...)`。

实现要点（`Aula.exchange`）：

1. `build_frames()` 分片并按 §2 组装帧，`syncFlag` 全局递增；
2. 发完 5 片后进入读循环，**每读到一个帧立刻回 ACK**；
3. 只接受 `frameIndex` 连续、且第 1 片的 `cmd/param` 与请求一致的包（过滤主动上报）；
4. 收满 5 片或超时结束，失败自动重发一次；
5. `packet_data(pkt, size)` 按固定长度取数据区（第一包；多包应答需按 `currentPacket` 拼接）。

## 6. 复现与继续挖掘

| 工具 | 作用 |
|---|---|
| `tools/aula_hid.py` | 协议参考实现 + 常用命令 |
| `tools/debug_rx.py` | 发一条命令并打印全部原始收发帧（调试利器） |
| `tools/proto.py` / `tools/show_capture.py` | 解析抓包日志 |
| `tools/deobf.js` | 还原 obfuscator.io 字符串表：`node tools/deobf.js tools/deobf-vendor/deobfuscated.js out.js` |
| `tools/deobf-vendor/deobf-strings.js` | 已还原的可读 SDK（5.3 MB） |
| `tools/cmdtable.py` | 从 SDK 提取 `方法名 → cmd/param` |
| `capture/*` | 网页端抓包原始记录 |

链路层源码在 `deobf-strings.js` 的 `buildFrame` / `splitFrame` / `parseFrame` / `buildAckFrame` / `sendAndWaitAck`；
应用包层在 `totalPacketSize: 63` 的 `config` 附近（`encode` / `buildCommands` / `setChecksum` / `calculateCrc`）。

### 校验记录

- `capture/hidlog-initial.txt` 全部 337 帧：魔数、`totalFrames = 5`、帧校验和、补零字节 100% 通过；
  其中分组完整的应用包 11 个，`Σ([0x09]+packet[0..61]+[crc]) == 0xFF` 全部成立
  （该文件是按序号去重后的流，少数分组会被去重打断，属采集副作用）。
- `capture/op-steady.json` / `op-lightmode.json` 的主机方向各 20 帧：帧校验与应用包校验全部通过。
- `tools/aula_hid.py` 对真机的 `0x82/0x01`、`0x87`、`0x84/0x13`、`0x84/0x17`、`0x84/0x20`、
  `0x82/0x0c`、`0x90` 均取到应答，连续多次运行结果一致。
- 逐条命令表（`docs/commands.md`）的读类命令：在页面里挂 `protocol.encode` 把所有读方法跑了一遍，
  并把结果与 `tools/aula_hid.py` 的**独立实现**逐字节对照，一致。例如 `0x82/0x03` 位图
  `3a e1 40 09 20 00 00 78` ↔ SDK 返回的开关号 `[1,3,4,5,8,13,14,15,22,24,27,37,59,60,61,62]`；
  `0x82/0x01` 的 6 字节 UUID ↔ SDK 的 `19791209299984`。

## 7. 尚未确定

- **有线链路未实测**：`§2.4` 的有线/2.4G 格式（63 字节整包直发、无帧级 ACK）来自 SDK 源码推导，
  手里只有 8K 接收器可测；`Aula.exchange_raw()` 同理未验证。
- **`*ByWireless` 裸报文**（§2.4 第三条通道）在本机 8K 接收器上是否被接受、有线时是否可用，均未实测。
- **`0x0A` 接收器上报**除 `byte0/byte4/byte5` 外的字段含义未确定。
- `KeyCalibration`（`0x94/2`）记录里 `press` / `finished` 的**精确取值位**未确证。
- DKS 每组 `trigger` 的枚举码 `{0,4,6,10,12,14}` 只解出取值范围，物理含义与 128/292/456 三个距离提示值来源未解明。
- `setMPT` 的最小距离兜底常量未解出。
- 多包行为：RT/死区一次下发超过每包条数时 SDK 会分包，页面侧没有等待/重试逻辑，设备端接受情况未实测。
- **`trigger.text15 全行程快速触发`**：模板渲染了这个开关，但逻辑层无对应字段/命令（空操作）；
  `trigger.text14`（"无线模式下暂不支持驱动实时查看校准状态…"）在 56 个 chunk 里**零引用**，
  疑为其它型号族遗留文案——触发页本身没有任何有线/无线分支。
- 灯光单属性读（`0x84/2..5`）在本机固件未实现（返回空）；单属性**写**（`0x04/2..5`）未逐个实测。
- **鼠标 / 接收器侧**那套协议（`generateCRC` / `WPpackets` / `ORDER_TYPE_*`，命令字 `0x0F/0x01/0x23/0x25` 等）
  与键盘这套并存，字段布局不同，本文只做了初步记录（`commands.md` §12）。
- 设备是否对 `syncFlag` 有隐含要求：实测主机可从任意起始值通信，但原厂 SDK 是连续递增的，建议保持该行为。
- `tools/deobf-vendor/deobf-strings.js` 里仍有**少量还原错误**：个别访问器的字符串表旋转量算错
  （例如触发模块那张 91 项表正确旋转量应为 9，工具算成了 0），表现为残留 `["wSeDy"]`、`o["3984184ftWMSA"]`
  这类假属性名。**cmd/param/字节长度等数字字面量不受影响**，本文件与 `commands.md` 的结论均与真机对照过。
