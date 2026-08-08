use anyhow::Result;
use dark_light::{Mode as SystemTheme, detect as detect_system_theme};

pub fn get_system_theme() -> Result<&'static str> {
    Ok(match detect_system_theme()? {
        SystemTheme::Dark => "dark",
        _ => "light",
    })
}
