//! Read-only probe for a real device (wired HERO 68 XS, PID 0x103E).
//!
//! Opens the configuration interface and performs READ-ONLY queries only:
//! UUID / firmware / battery / profile / one keymap record (id 1).
//! Never sends any write command.
//!
//! Run: `cargo run --example probe` (from `src-tauri/`).

use aula_driver_lib::hid::Hid;
use aula_driver_lib::service::KeyEntry;

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
    let a = aula_driver_lib::service::AulaDevice::new(dev, desc);
    println!("link: framed={}", a.is_framed());

    println!("uuid      (0x82/0x01): {:02x?}", a.uuid()?);
    println!("firmware  (0x82/0x02): {}", a.firmware_version()?);
    println!("battery   (0x87/0x00): {:?}", a.battery()?);
    println!("profile   (0x90/0x00): {}", a.profile()?);

    let keys = a.read_keymap(0, 0, &[1u16])?;
    let KeyEntry { id, keycode } = keys[0];
    println!("keymap L0 id={id}: keycode=0x{keycode:08X} (expect 0x00000029 = ESC)");
    Ok(())
}
