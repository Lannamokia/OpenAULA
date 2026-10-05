# 键码表与自定义改键

`docs/commands.md` §2 的配套参考：改键用的 32 位键码结构、完整键码表、改键页的选项分类、
以及本机型（68 键）的键位 id 表。

## 1. 32 位键码结构

键位映射（`0x83` 读 / `0x03` 写）里的 `keycode` 是 **32 位无符号整数**，**高字节是类型**：

| 高字节 | 类型 | 编码方式 |
|---|---|---|
| `0x00` | 普通按键 / 修饰键 / 复合键 | 低 16 位 = USB HID 用法码（§3）；修饰键单占一位（见下）；复合键 = 修饰位 \| (HID << 8) |
| `0x01` | 鼠标按键 | `0x01 << 24 \| 按钮号 << 16 \| 0x01 << 8`，按钮号 1..5 = 左/右/中/后退/前进（`0x01010100` = 左键） |
| `0x02` | 媒体/Consumer 键 | `0x02 << 24 \| Consumer Usage`（低 16 位），如 `0x020000cd` = 播放/暂停、`0x02000223` = 浏览器主页 |
| `0x03` | 宏键 | `(3 << 24) \| (loopType << 16) \| (loopCount << 8) \| index`（SDK `encodeMacroKeycode`） |
| `0x0d` | Fn 功能键 | `0x0d000000` = Fn、`0x0d010000` = Fn1 |
| `0x10` | 连发键（Rapid Fire） | `(0x10 << 24) \| ((普通键码 & 0xFF) << 16) \| ((次数 & 0xFF) << 8) \| (间隔ms & 0xFF)`（SDK `encodeRapidFireKeycode`） |
| `0x12` | 文本宏键 | `(0x12 << 24) \| (loopType << 16) \| (loopCount << 8) \| slot`（SDK `encodeTextMacroKeycode`） |

判型：`type = (keycode >>> 24) & 0xFF`。SDK 只对 `0x03/0x10/0x12` 提供判据函数
（`isMacroKeycode` / `isRapidFireKeycode` / `isTextMacroKeycode`），`0x01/0x02/0x0d` 是前端表里的字面量。

### 修饰键位（位 16–22，各占一位）

| 位 | 值 | 键 |
|---|---|---|
| 16 | `0x00010000` | L-Ctrl |
| 17 | `0x00020000` | L-Shift |
| 18 | `0x00040000` | L-Alt |
| 19 | `0x00080000` | L-Win / L-Cmd |
| 20 | `0x00100000` | R-Ctrl |
| 21 | `0x00200000` | R-Shift |
| 22 | `0x00400000` | R-Alt |

### 复合键 = 修饰位 \| (HID << 8)

实测/前端表内实例（`Bytech-BANInpeY.js` 的 `keyboardMap`）：

| 键 | keycode | 拆解 |
|---|---|---|
| Ctrl+A | `0x00010400` | L-Ctrl \| (KeyA 0x04 << 8) |
| Ctrl+Shift+Esc | `0x00032900` | L-Ctrl \| L-Shift \| (Escape 0x29 << 8) |
| Alt+Tab | `0x00042b00` | L-Alt \| (Tab 0x2b << 8) |
| Ctrl+Alt+Del | `0x00054c00` | L-Ctrl \| L-Alt \| (Delete 0x4c << 8) |
| Win+D | `0x00080700` | L-Win \| (KeyD 0x07 << 8) |
| Win+Ctrl+NumpadEnter | `0x00095800` | L-Win \| L-Ctrl \| (NumpadEnter 0x58 << 8) |

> 注意：`0x00010000` 这类**只有修饰位、低 16 位为 0** 的值就是「单独的修饰键」（如 id 55 = L-Shift = `0x00020000`）。
> 别把它当无效值——这是设备里修饰键的真实存储形式。

改成「无功能」用 `0x00000000`（SDK 键码表里的 `None`）。**注意改键页的选择器没有「禁用」这一项**，
`0x00000000` 是协议层能力（宏动作/高级键里会用到）。

## 2. 读写流程

| 操作 | 命令 | 说明 |
|---|---|---|
| 读一批键 | `0x83` | data = 每个 id `BE16`，**每包 ≤9 个 id**（上限 18 字节）；应答按 6 字节切片 |
| 读一个键 | `0x83` | data = `BE16(id)`；应答 6 字节记录（前端刷新时逐键调用） |
| 写一批键 | `0x03` | 每条 6 字节：`BE16(id) + BE32(keycode)`；每包 ≤9 条（前端「应用」就是批量提交选中键） |
| 写一个键 | `0x03` | 同上，单条（前端用于恢复默认、绑定/解绑宏、删除高级键） |
| 恢复默认映射 | `0x11` | param = `ELS`，data = `[1]`（KeyReset）。**前端改键页不调用它**，而是逐键把默认值写回 |

`param = ELS = (layer & 3) | ((system & 7) << 2)`：
- `layer`：`0` = 基础层、`1` = Fn 层、`2` = Fn1 层（前端 `FnMenu` 就 3 项：`WIN 基础层` / `Win Fn` / `Win Fn1`；Mac 下是 `Mac Base` / `Mac Fn` / `Mac Fn1`）
- `system`：`0` = Windows、`1` = macOS

**Fn 层用同一套 id、不同 `param`**，不占键码空间。切层就是换 `param` 重读整张表。

应答记录（6 字节）：`[0..1]`=id（BE16）、`[2..5]`=keycode（BE32，无符号）。

## 3. 键码表（170 项，SDK 内置）

| 键码 | 名称 | 键码 | 名称 | 键码 | 名称 |
|---|---|---|---|---|---|
| `0x0000` None | `0x0001` ErrorOVF | `0x0004` KeyA |
| `0x0005` KeyB | `0x0006` KeyC | `0x0007` KeyD |
| `0x0008` KeyE | `0x0009` KeyF | `0x000a` KeyG |
| `0x000b` KeyH | `0x000c` KeyI | `0x000d` KeyJ |
| `0x000e` KeyK | `0x000f` KeyL | `0x0010` KeyM |
| `0x0011` KeyN | `0x0012` KeyO | `0x0013` KeyP |
| `0x0014` KeyQ | `0x0015` KeyR | `0x0016` KeyS |
| `0x0017` KeyT | `0x0018` KeyU | `0x0019` KeyV |
| `0x001a` KeyW | `0x001b` KeyX | `0x001c` KeyY |
| `0x001d` KeyZ | `0x001e` Digit1 | `0x001f` Digit2 |
| `0x0020` Digit3 | `0x0021` Digit4 | `0x0022` Digit5 |
| `0x0023` Digit6 | `0x0024` Digit7 | `0x0025` Digit8 |
| `0x0026` Digit9 | `0x0027` Digit0 | `0x0028` Enter |
| `0x0029` Escape | `0x002a` Backspace | `0x002b` Tab |
| `0x002c` Space | `0x002d` Minus | `0x002e` Equal |
| `0x002f` BracketLeft | `0x0030` BracketRight | `0x0031` Backslash |
| `0x0032` IntlHash | `0x0033` Semicolon | `0x0034` Quote |
| `0x0035` Backquote | `0x0036` Comma | `0x0037` Period |
| `0x0038` Slash | `0x0039` CapsLock | `0x003a` F1 |
| `0x003b` F2 | `0x003c` F3 | `0x003d` F4 |
| `0x003e` F5 | `0x003f` F6 | `0x0040` F7 |
| `0x0041` F8 | `0x0042` F9 | `0x0043` F10 |
| `0x0044` F11 | `0x0045` F12 | `0x0046` PrintScreen |
| `0x0047` ScrollLock | `0x0048` Pause | `0x0049` Insert |
| `0x004a` Home | `0x004b` PageUp | `0x004c` Delete |
| `0x004d` End | `0x004e` PageDown | `0x004f` ArrowRight |
| `0x0050` ArrowLeft | `0x0051` ArrowDown | `0x0052` ArrowUp |
| `0x0053` NumLock | `0x0054` NumpadDivide | `0x0055` NumpadMultiply |
| `0x0056` NumpadSubtract | `0x0057` NumpadAdd | `0x0058` NumpadEnter |
| `0x0059` Numpad1 | `0x005a` Numpad2 | `0x005b` Numpad3 |
| `0x005c` Numpad4 | `0x005d` Numpad5 | `0x005e` Numpad6 |
| `0x005f` Numpad7 | `0x0060` Numpad8 | `0x0061` Numpad9 |
| `0x0062` Numpad0 | `0x0063` NumpadDecimal | `0x0064` IntlBackslash |
| `0x0065` ContextMenu | `0x0066` Power | `0x0067` NumpadEqual |
| `0x0068` F13 | `0x0069` F14 | `0x006a` F15 |
| `0x006b` F16 | `0x006c` F17 | `0x006d` F18 |
| `0x006e` F19 | `0x006f` F20 | `0x0070` F21 |
| `0x0071` F22 | `0x0072` F23 | `0x0073` F24 |
| `0x0074` Open | `0x0075` Help | `0x0076` Props |
| `0x0077` Front | `0x0078` Stop | `0x0079` Again |
| `0x007a` Undo | `0x007b` Cut | `0x007c` Copy |
| `0x007d` Paste | `0x007e` Find | `0x007f` AudioVolumeMute |
| `0x0080` AudioVolumeUp | `0x0081` AudioVolumeDown | `0x0085` NumpadComma |
| `0x0087` IntlRo | `0x0088` KanaMode | `0x0089` IntlYen |
| `0x008a` Convert | `0x008b` NonConvert | `0x008c` NumpadComma |
| `0x0090` Lang1 | `0x0091` Lang2 | `0x0092` KanaMode |
| `0x0093` KanaMode | `0x0094` Zenkaku | `0x00b6` NumpadParenLeft |
| `0x00b7` NumpadParenRight | `0x00e0` ControlLeft | `0x00e1` ShiftLeft |
| `0x00e2` AltLeft | `0x00e3` MetaLeft | `0x00e4` ControlRight |
| `0x00e5` ShiftRight | `0x00e6` AltRight | `0x00e7` MetaRight |
| `0x00e8` MediaPlayPause | `0x00e9` MediaStop | `0x00ea` MediaTrackPrevious |
| `0x00eb` MediaTrackNext | `0x00ec` Eject | `0x00ed` AudioVolumeUp |
| `0x00ee` AudioVolumeDown | `0x00ef` AudioVolumeMute | `0x00f0` BrowserHome |
| `0x00f1` BrowserBack | `0x00f2` BrowserForward | `0x00f3` BrowserStop |
| `0x00f4` BrowserSearch | `0x00f5` ScrollUp | `0x00f6` ScrollDown |
| `0x00f7` Edit | `0x00f8` Sleep | `0x00f9` WakeUp |
| `0x00fa` BrowserRefresh | `0x00fb` LaunchApp2 |  |

说明：表取自 SDK 内置映射（`deobf-strings.js` 的 `const IM = {...}`，170 项），主体是标准 USB HID Usage ID；
源表里有重名项（`NumpadComma` 0x85/0x8C、`KanaMode` 0x88/0x92/0x93），**以数值为准**。

## 4. 改键页的七类选项（前端 `keyboardMap`）

改键页的选择器固定 7 个页签，条目全部来自前端表 `keyboardMap`，选中后**原值**写入 `keycode`：

| 页签 | `type` | 条目数 | 说明 |
|---|---|---|---|
| 键盘按键 | 缺省（带 `x` 坐标） | 104 | 普通键位，`keycode` 就是 §3 的用法码 |
| 系统 | 0 | 13 | Fn/Fn1、屏幕亮度±、邮件、计算器、我的电脑、浏览器、收藏夹、显示桌面、放大/缩小、任务管理器 |
| Ctrl组合 | 1 | 17 | Ctrl+ESC/A/C/F/N/O/S/T/V/W/X/Y/Z/0/;/. 、Ctrl+Shift+Esc |
| Alt组合 | 2 | 5 | Alt+ESC/Tab/F4/→/← |
| Win组合 | 3 | 17 | Win+L/D/A/B/E/G/I/K/R/S/T/U/X/tab/=/. 、Win+Ctrl+NumpadEnter |
| 鼠标 | 4 | 5 | 左/右/中/后退/前进键 |
| 媒体 | 5 | 8 | 下一首/上一首/停止/播放暂停/静音/音量±/系统多媒体键 |

各页签里那些非普通值就是 §1 的编码，例如：

```
系统：  Fn=0x0d000000  Fn1=0x0d010000  屏幕亮度+=0x0200006f  显示桌面=0x00080007  任务管理器=0x00054c00
Ctrl：  Ctrl+A=0x00010400   Ctrl+Shift+Esc=0x00032900
Alt：   Alt+Tab=0x00042b00
Win：   Win+D=0x00080700   Win+Ctrl+NumpadEnter=0x00095800
鼠标：  左键=0x01010100  右键=0x01020100  中键=0x01030100
媒体：  播放/暂停=0x020000cd  音量+=0x020000e9  静音=0x020000e2
```

> 宏/连发/文本宏键（`0x03`/`0x10`/`0x12`）**不在这 7 个页签里**，它们由宏面板/高级键走单独的入口；
> 但都落在同一个 32 位键码空间，可以混用。

## 5. 本机型（68 键）键位 id 表

id 不是从行列算出来的，是固件里固定的**键序号**；前端把每个型号的布局表写死在
`Bytech-BANInpeY.js`（局部数组 `o`，含 `keyValue`=id、`x/y/width/height`=键盘图坐标）。
本机型（68 键）的 id 全集是 `[1, 15..77, 98, 99, 102, 103]`，行分布 15/15/14/14/10。

```
 id  键名        默认 keycode   browserCode      id  键名        默认 keycode   browserCode
  1  ESC         0x00000029     Escape           55  L-Shift     0x00020000     ShiftLeft
 15  !1          0x0000001e     Digit1           56  Z           0x0000001d     KeyZ
 16  @2          0x0000001f     Digit2           57  X           0x0000001b     KeyX
 17  #3          0x00000020     Digit3           58  C           0x00000006     KeyC
 18  $4          0x00000021     Digit4           59  V           0x00000019     KeyV
 19  %5          0x00000022     Digit5           60  B           0x00000005     KeyB
 20  ^6          0x00000023     Digit6           61  N           0x00000011     KeyN
 21  &7          0x00000024     Digit7           62  M           0x00000010     KeyM
 22  *8          0x00000025     Digit8           63  <,          0x00000036     Comma
 23  (9          0x00000026     Digit9           64  >.          0x00000037     Period
 24  )0          0x00000027     Digit0           65  ?/          0x00000038     Slash
 25  _-          0x0000002d     Minus            66  R-Shift     0x00200000     ShiftRight
 26  +=          0x0000002e     Equal            67  L-Ctrl      0x00010000     ControlLeft
 27  Back Space  0x0000002a     Backspace        68  L-Win/CMD   0x00080000     MetaLeft
 28  Tab         0x0000002b     Tab              69  L-Alt/OPT   0x00040000     AltLeft
 29  Q           0x00000014     KeyQ             70  Space       0x0000002c     Space
 30  W           0x0000001a     KeyW             71  R-Alt/CMD   0x00400000     AltRight
 31  E           0x00000008     KeyE             72  Fn          0x0d000000     (空)
 32  R           0x00000015     KeyR             73  R-Ctrl/OPT  0x00100000     ControlRight
 33  T           0x00000017     KeyT             74  ↑           0x00000052     ArrowUp
 34  Y           0x0000001c     KeyY             75  ↓           0x00000051     ArrowDown
 35  U           0x00000018     KeyU             76  ←           0x00000050     ArrowLeft
 36  I           0x0000000c     KeyI             77  →           0x0000004f     ArrowRight
 37  O           0x00000012     KeyO             98  Insert      0x00000049     Insert
 38  P           0x00000013     KeyP             99  Del         0x0000004c     Delete
 39  {[          0x0000002f     BracketLeft     102  PgUp        0x0000004b     PageUp
 40  }]          0x00000030     BracketRight    103  PgDn        0x0000004e     PageDown
 41  |\          0x00000031     Backslash
 42  CapLc       0x00000039     CapsLock
 43  A           0x00000004     KeyA
 44  S           0x00000016     KeyS
 45  D           0x00000007     KeyD
 46  F           0x00000009     KeyF
 47  G           0x0000000a     KeyG
 48  H           0x0000000b     KeyH
 49  J           0x0000000d     KeyJ
 50  K           0x0000000e     KeyK
 51  L           0x0000000f     KeyL
 52  :;          0x00000033     Semicolon
 53  "'          0x00000034     Quote
 54  Enter       0x00000028     Enter
```

**本表已与真机对照**：逐 id 发 `0x83` 读回的默认 keycode 与上表**逐项一致**
（例如 id 55 → `0x00020000`、id 72 → `0x0d000000`、id 74..77 → 方向键），两边互为印证。

⚠ **不存在的键位 id 会返回垃圾值**（不是"无键"）：实测 id 6/9/12 → `((id+1)<<16)|(id+2)` 形态
（`0x00070008`、`0x000a000b`…），id 81/84/87/90/93/96/105 → 同类规律值。
**这些 id 不在本机型布局表里**，实现时应以布局表（或先探测）为准，不要盲目遍历 id 空间。

## 6. 三个层级（Fn 层）——已真机实测

改键页左侧菜单三项（对应截图）：**`WIN 基础层` / `Win Fn` / `Win Fn1`**（Mac 下为 `Mac Base / Mac Fn / Mac Fn1`），
切换即换 `param` 的 `layer` 位重读整张 keymap：

| 层 | `layer` | `param`（system=Windows） | 内容（本机实测） |
|---|---|---|---|
| 基础层 | 0 | `0x00` | 完整 68 键（字母/数字/修饰键），仅 Fn 键自身是 `0x0d000000` |
| Fn | 1 | `0x01` | **43 个键与基础层不同**：功能行 → F1..F12、`Fn+ESC` → `` ` ``、其余 41 个是设备自定义的 Fn 功能 |
| Fn1 | 2 | `0x02` | **13 个键不同**：功能行 → 媒体/浏览器键（`0x02000194` 我的电脑、`0x02000223` 浏览器、`0x0200018a` 邮件、`0x020000cd` 播放/暂停、`0x020000e5`… 音量±、`0x02000192` 计算器…） |

**三张表是彼此独立的**（同一 id 在不同层可以完全不同；实测往 Fn1 层写值不影响基础层）。
读法：`0x83` + `param = (layer & 3) | ((system & 7) << 2)`，每包 ≤9 个 id。

> Fn 层里出现了**前端键位表里没有的类型字节**：`0x07` / `0x08` / `0x09`。
> 前端代码里**根本不会构造**这三种码（全库只有 `1<<24` 鼠标、`3<<24` 宏、`0x10/0x12` 连发/文本宏），
> 所以这些是**固件出厂定义的 Fn 功能键**：驱动只能读出来、连名字都没有（UI 回落显示该键的默认名）。

### 6.1 Fn 层功能键实测清单（本机 24 个）

> 2026-10-06 复读：layer 1（Win Fn）共 24 个功能键；**layer 2（Win Fn1）读回来一个都没有**
> （整层无 `0x07/0x08/0x09`）。下表键码为设备实测值。

**已确认（用户实机按键逐个确认）**：

| 按键 | 键码 | 含义 |
|---|---|---|
| Fn+N / Fn+M / Fn+, | `0x09000000` / `0x09000001` / `0x09000002` | 切换到板载配置 1 / 2 / 3（`0x09` + 低字节 = 配置序号，0-based） |
| Fn+PgUp | `0x08000000` | **输入区**灯效切换 |
| Fn+RAlt | `0x08000001` | **侧灯（氛围灯）**灯效切换 |
| Fn+Del | `0x08020000` | **输入区**颜色切换 |
| Fn+X | `0x08020001` | **侧灯（氛围灯）**颜色切换 |
| Fn+C | `0x08030001` | **侧灯（氛围灯）**亮度切换 |
| Fn+↑ / Fn+↓ | `0x08030100` / `0x08030200` | **输入区**灯光亮度 + / − |
| Fn+Z | `0x08040001` | **侧灯（氛围灯）**速度切换 |
| Fn+→ / Fn+← | `0x08040100` / `0x08040200` | **输入区**灯光速度 + / − |
| Fn+Q | `0x07000008` | **无反应**（疑为该型号未实现/预留给其它型号） |

**编码规律（2026-10-06 全部按键确认，无推测项）**：

```
type 0x09:  0x09 00 <profile>              切板载配置 (0-based)

type 0x08:  0x08 <attr> <dir> <target>
    <attr>   属性 —— 与灯光命令 param 的偏移一致: 0=整块/效果  2=颜色  3=亮度  4=速度
    <dir>    动作: 1 = 加   2 = 减   0 = 切换(循环)
    <target> 目标灯区: 0 = 输入区灯(主灯 base 1)   1 = 侧灯/氛围灯(base 6)
```

排成矩阵就是一张完整的「Fn 灯光控制图」：

| | target=0 输入区灯（主灯） | target=1 侧灯（氛围灯） |
|---|---|---|
| attr0 灯效 | Fn+PgUp（切换） | Fn+RAlt（切换） |
| attr2 颜色 | Fn+Del（切换） | Fn+X（切换） |
| attr3 亮度 | Fn+↑ + / Fn+↓ − | Fn+C（切换） |
| attr4 速度 | Fn+→ + / Fn+← − | Fn+Z（切换） |

⚠ **`target=1` 是「侧灯」不是「灯箱」**——初版文档按「装饰灯」推成了灯箱，用户实机按键纠正：
Fn+X/C/Z 这一组作用在**侧灯/氛围灯**上。这也和 §4.2 的结论自洽：本机型根本没有灯箱灯区
（base 35 写入被 ACK 但读回不变），Fn 键不可能去控一个不存在的区。

规律自洽性：`attr3`/`attr4` 的「加/减」形式只出现在输入区（↑↓→←），侧灯那侧只有「切换」形式
（C 亮度循环、Z 速度循环）——对应侧灯区没有独立亮度± 按键的产品设计。四个 `attr` × 两个 `target`
里，产品实际用掉了 10 个格子（上表），其余组合（如输入的 attr0/attr2 加减、侧灯的加/减）本机不存在。

**type `0x07`** 的低字节是功能编号（1/4/5/6/7/8/11/12/14/15/20），语义仍未知：

| 按键 | 键码 | 按键 | 键码 |
|---|---|---|---|
| Fn+LWin | `0x07000001` | Fn+T | `0x07000007` |
| Fn+Space | `0x07000004` | Fn+A | `0x0700000e` |
| Fn+E | `0x07000005` | Fn+S | `0x0700000f` |
| Fn+R | `0x07000006` | Fn+B | `0x0700000c` |
| | | Fn+Enter | `0x07000014` |
| | | Fn+Ins | `0x0700000b` |

Fn+Q（编号 8）在本机无反应，说明这批功能**与型号相关**，驱动侧完全不参与
（前端连构造 `0x07/0x08/0x09` 的代码都没有）。

### 6.2 宏（快捷指令）怎么绑定到不同层级的按键

机制（前端 + SDK + 真机三方一致）：

1. **宏体是全局的**：宏（名称 + 动作序列）只存一份，放在宏区（`0x05` 写、`0x85` 读，本机容量 4096 字节）。
2. **绑定发生在某一层的某个键上**：写键位映射时，把该键的 `keycode` 写成宏键码
   `(3 << 24) | (loopType << 16) | (loopCount << 8) | macroIndex`，
   并带上那一层的 `param` → 即 `setKeymap({layer, system, id, keycode})`。
3. 因此**同一个宏可以绑到不同层的不同键**，也可以一个层绑、另一层不绑；层的绑定彼此独立。
4. 循环方式（`loopType`）编在键码里：`1` = 指定循环次数、`2` = 重复直至任意键按下、`3` = 按住重复松开停止。

**真机验证（可回滚实验）**：

```
Fn1 层 id 63 原始 = 0x00000036 (Comma)
写入宏键码 0x03010100  →  读回 0x03010100   ✓ 设备接受
同一 id 的基础层 = 0x00000036              ✓ 未被污染（层独立）
写回原值 → 读回 0x00000036                 ✓ 已还原
```

（`0x03010100` = 宏键、`loopType=1`、`loopCount=1`、`macroIndex=0`）

## 7. 相关源码位置

| 内容 | 位置 |
|---|---|
| 键码表 `IM` | `tools/deobf-vendor/deobf-strings.js` 56179 起 |
| `encodeMacroKeycode` / `isMacroKeycode` | 同文件 56852 / 56870 |
| `isTextMacroKeycode` / `encodeTextMacroKeycode` | 同文件 62867 起 |
| `encodeRapidFireKeycode` / `decodeRapidFireKeycode` | 同文件 55692 / 55722 |
| `getKeymaps` / `setKeymaps` | 同文件 55614 / 55566 |
| 前端键位表 `keyboardMap`（181 项） | `site/assets/Bytech-BANInpeY.js`（局部 `y`，约 55955 起） |
| 本机型 68 键布局表 | `site/assets/Bytech-BANInpeY.js`（局部 `o`，约 6104 起） |
| 改键页逻辑 | `site/assets/key-CAVryEkN.js`、`info-BIMJ29R_.js` |

## 8. 已确认与未确定

**已确认（模板 chunk `index-hgKF_tct.js` 已抓到，逐条核对）**：

- Fn 三层菜单 = `Base / Fn / Fn1`（Win 下显示 `WIN 基础层 / Win Fn / Win Fn1`，Mac 下 `Mac Base / Mac Fn / Mac Fn1`），
  切换即换 `layer` 重读整张 keymap。
- 七个页签标签 = `键盘按键 / 系统 / Ctrl组合 / Alt组合 / Win组合 / 鼠标 / 媒体`，分组规则同 §4。
- **本机型没有「禁用按键」选项**（`keyboardMap` 328 条里无 disable 项，7 个页签也没有）——
  要屏蔽某键只能用协议层的 `0x00000000`。
- 宏绑定到键走单键 `setKeymap`，`keycode = encodeMacroKeycode(idx, loopType, loopCount)`；
  点已绑宏的键时会 `decodeMacroKeycode` 回填编辑面板。

**未确定**：

- 连发/文本宏键（`0x10`/`0x12`）在改键页**没有入口**（连发只在鼠标类预览页出现）——
  它们仍是协议层能力，SDK 侧编码器齐全。
