//! Read-only probe for a real device (wired HERO 68 XS, PID 0x103E).
//!
//! Opens the configuration interface and performs READ-ONLY queries only:
//! UUID / firmware / battery / profile / profile names / keymap / macros /
//! advanced keys / lighting zones. Never sends any write command.
//!
//! Run: `cargo run --example probe` (from `src-tauri/`).

use aula_driver_lib::advanced;
use aula_driver_lib::hid::Hid;
use aula_driver_lib::lighting::ZONES;
use aula_driver_lib::service::{AulaDevice, KeyEntry};

fn main() -> Result<(), String> {
    let hid = Hid::new()?;
    let devs = hid.list();
    println!("configuration interfaces found: {}", devs.len());
    for d in &devs {
        println!(
            "  pid=0x{:04X} usage_page=0x{:04X} usage=0x{:02X} framed={} product={:?}",
            d.product_id, d.usage_page, d.usage, d.framed, d.product
        );
    }
    let (dev, desc) = hid.open(None)?;
    let reader = hid.open_raw(&desc.path)?;
    let a = AulaDevice::new(dev, reader, desc);
    println!("link: framed={}", a.is_framed());

    println!("uuid      (0x82/0x01): {:02x?}", a.uuid()?);
    println!("firmware  (0x82/0x02): {}", a.firmware_version()?);
    println!("battery   (0x87/0x00): {:?}", a.battery()?);
    let profile = a.profile()?;
    println!("profile   (0x90/0x00): {profile}");

    for p in 0..3u8 {
        match a.read_profile_name(p) {
            Ok(Some(n)) => println!("  profile {p} name (0x9A): {n:?}"),
            Ok(None) => println!("  profile {p} name (0x9A): （未命名）"),
            Err(e) => println!("  profile {p} name (0x9A): 读取失败 {e}"),
        }
    }

    let keys = a.read_keymap(0, 0, &[1u16])?;
    let KeyEntry { id, keycode } = keys[0];
    println!("keymap L0 id={id}: keycode=0x{keycode:08X} (expect 0x00000029 = ESC)");

    println!("\n--- 宏 (0x85/0x05) ---");
    match a.read_macros() {
        Ok(m) => {
            println!(
                "capacity={} 已读={} 头表={} 空区={} 宏数={}",
                m.capacity,
                m.total_len,
                m.header_len,
                m.empty,
                m.macros.len()
            );
            for (i, mac) in m.macros.iter().enumerate() {
                println!("  [{i}] {:?} 动作 {} 个", mac.name, mac.actions.len());
            }
        }
        Err(e) => println!("读取失败: {e}"),
    }

    println!("\n--- 高级键 (0x92) ---");
    for layer in 0u8..3 {
        match advanced::read_all(&a, layer, 0) {
            Ok(list) if list.is_empty() => println!("  layer {layer}: （无）"),
            Ok(list) => {
                let s: Vec<String> = list
                    .iter()
                    .map(|e| match &e.key {
                        Some(k) => format!("id{}={}", e.id, k.kind),
                        None => format!("id{}=空槽", e.id),
                    })
                    .collect();
                println!("  layer {layer}: {}", s.join(" "));
            }
            Err(e) => println!("  layer {layer}: 读取失败 {e}"),
        }
    }

    println!("\n--- 灯光 (0x84/<base>) ---");
    for (base, name) in ZONES {
        match a.read_zone_effect(base, false) {
            Ok(e) => println!(
                "  {name:<6} base={base:<3} effect={} colorIndex={} rgb={:02x},{:02x},{:02x} 亮度={} 速度={}",
                e.effect_id, e.color_index, e.color.r, e.color.g, e.color.b, e.brightness, e.speed
            ),
            Err(e) => println!("  {name:<6} base={base:<3} 读取失败: {e}"),
        }
    }

    println!("\n--- 触发能力 (0x82) ---");
    match a.trigger_caps() {
        Ok(c) => {
            println!(
                "  行程精度={} ({}mm)  最小RT={}  支持的开关={:?}  高级键类型位图=0x{:02x}  磁轴={}",
                c.travel_precision,
                c.travel_precision as f32 / 1000.0,
                c.min_rapid_trigger,
                c.switch_ids,
                c.advanced_key_types,
                c.magnetic
            );
        }
        Err(e) => println!("  读取失败: {e}"),
    }
    let probe_ids: Vec<u16> = (1..=3).collect();
    for (label, r) in [
        ("RT    (0x99)", a.read_rapid_triggers(0, 0, &probe_ids).map(|v| format!("{v:?}"))),
        ("行程  (0x93)", a.read_key_travel(0, 0, &probe_ids).map(|v| format!("{v:?}"))),
        ("轴体  (0x95)", a.read_switch_types(&probe_ids).map(|v| format!("{v:?}"))),
        ("死区  (0x96)", a.read_safe_area(&probe_ids).map(|v| format!("{v:?}"))),
        ("AD范围(0x94/5)", a.read_ad_range(&probe_ids).map(|v| format!("{v:?}"))),
    ] {
        match r {
            Ok(s) => println!("  {label}: {s}"),
            Err(e) => println!("  {label}: 读取失败 {e}"),
        }
    }

    println!("\n--- 系统开关 (0x84/<n>) ---");
    match a.device_settings() {
        Ok(s) => println!("  {s:?}"),
        Err(e) => println!("  读取失败: {e}"),
    }
    println!("  caps: {:?}", a.settings_caps());
    Ok(())
}
