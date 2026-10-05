# Regenerates data/layout68.json from the raw layout + the verified id table in
# docs/keycodes.md sec.5. Run from the repo root: python tools/gen_layout.py
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# id: (label, default keycode) -- verified against the real device
# (docs/keycodes.md sec.5, "本机型（68 键）键位 id 表").
IDS = {
    1: ("ESC", 0x00000029), 15: ("!1", 0x0000001E), 16: ("@2", 0x0000001F),
    17: ("#3", 0x00000020), 18: ("$4", 0x00000021), 19: ("%5", 0x00000022),
    20: ("^6", 0x00000023), 21: ("&7", 0x00000024), 22: ("*8", 0x00000025),
    23: ("(9", 0x00000026), 24: (")0", 0x00000027), 25: ("_-", 0x0000002D),
    26: ("+=", 0x0000002E), 27: ("Back Space", 0x0000002A), 28: ("Tab", 0x0000002B),
    29: ("Q", 0x00000014), 30: ("W", 0x0000001A), 31: ("E", 0x00000008),
    32: ("R", 0x00000015), 33: ("T", 0x00000017), 34: ("Y", 0x0000001C),
    35: ("U", 0x00000018), 36: ("I", 0x0000000C), 37: ("O", 0x00000012),
    38: ("P", 0x00000013), 39: ("{[", 0x0000002F), 40: ("}]", 0x00000030),
    41: ("|\\", 0x00000031), 42: ("CapLc", 0x00000039), 43: ("A", 0x00000004),
    44: ("S", 0x00000016), 45: ("D", 0x00000007), 46: ("F", 0x00000009),
    47: ("G", 0x0000000A), 48: ("H", 0x0000000B), 49: ("J", 0x0000000D),
    50: ("K", 0x0000000E), 51: ("L", 0x0000000F), 52: (":;", 0x00000033),
    53: ("'\"", 0x00000034), 54: ("Enter", 0x00000028), 55: ("L-Shift", 0x00020000),
    56: ("Z", 0x0000001D), 57: ("X", 0x0000001B), 58: ("C", 0x00000006),
    59: ("V", 0x00000019), 60: ("B", 0x00000005), 61: ("N", 0x00000011),
    62: ("M", 0x00000010), 63: ("<,", 0x00000036), 64: (">.", 0x00000037),
    65: ("?/", 0x00000038), 66: ("R-Shift", 0x00200000), 67: ("L-Ctrl", 0x00010000),
    68: ("L-Win/CMD", 0x00080000), 69: ("L-Alt/OPT", 0x00040000),
    70: ("Space", 0x0000002C), 71: ("R-Alt/CMD", 0x00400000),
    72: ("Fn", 0x0D000000), 73: ("R-Ctrl/OPT", 0x00100000),
    74: ("Up", 0x00000052), 75: ("Down", 0x00000051), 76: ("Left", 0x00000050),
    77: ("Right", 0x0000004F), 98: ("Insert", 0x00000049), 99: ("Del", 0x0000004C),
    102: ("PgUp", 0x0000004B), 103: ("PgDn", 0x0000004E),
}


def main() -> None:
    layout = json.loads((ROOT / "src-tauri/data/layout68.json").read_text("utf-8"))
    out = []
    for e in layout:
        key_id = e["keyValue"]
        name, default = IDS[key_id]
        out.append({**e, "name": name, "defaultKeycode": default})
    (ROOT / "src-tauri/data/layout68.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1) + "\n", "utf-8")
    (ROOT / "src/data/layout68.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1) + "\n", "utf-8")
    print(f"layout68.json: {len(out)} keys enriched")


if __name__ == "__main__":
    main()
