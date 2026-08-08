#[allow(unused_imports)]
use crate::config::{Config, WorkrunPatch};
use crate::{
    core::{autostart, logger::Logger, tray},
    logging,
    utils::logging::Type,
};
use anyhow::Result;
use bitflags::bitflags;

// Define update flags as bitflags for better performance
bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
    struct UpdateFlags: u16 {
        const LAUNCH = 1 << 0;
        const LOCALE = 1 << 1;
        const LOG_LEVEL = 1 << 2;
        const LOG_FILE = 1 << 3;
    }
}

/// Patch Workrun Configuration
pub async fn patch_workrun(patch: &WorkrunPatch, need_save_file: bool) -> Result<()> {
    Config::workrun().await.edit_draft(|s| s.patch_config(patch));

    let update_flags = determine_update_flags(patch);
    logging!(debug, Type::Setup, "Determined update flags: {:?}", update_flags);
    let process_flag_result: std::result::Result<(), anyhow::Error> = {
        process_terminated_flags(update_flags, patch).await?;
        Ok(())
    };

    if let Err(err) = process_flag_result {
        Config::workrun().await.discard();
        return Err(err);
    }
    Config::workrun().await.apply();
    if need_save_file {
        let workrun_data = Config::workrun().await.data_arc();
        logging!(debug, Type::Setup, "Saving Workrun configuration to file...");
        workrun_data.save_config().await?;
    }
    Ok(())
}

fn determine_update_flags(patch: &WorkrunPatch) -> UpdateFlags {
    let auto_launch = patch.enable_auto_launch;
    let locale = &patch.locale;
    let log_level = &patch.app_log_level;
    let log_max_size = patch.app_log_max_size;
    let log_max_count = patch.app_log_max_count;

    let mut update_flags = UpdateFlags::empty();

    if auto_launch.is_some() {
        update_flags.insert(UpdateFlags::LAUNCH);
    }
    if locale.is_some() {
        update_flags.insert(UpdateFlags::LOCALE);
    }
    if log_level.is_some() {
        update_flags.insert(UpdateFlags::LOG_LEVEL);
    }
    if log_max_size.is_some() || log_max_count.is_some() {
        update_flags.insert(UpdateFlags::LOG_FILE);
    }

    update_flags
}

async fn process_terminated_flags(update_flags: UpdateFlags, patch: &WorkrunPatch) -> Result<()> {
    if update_flags.contains(UpdateFlags::LAUNCH) {
        autostart::update_launch().await?;
    }
    if update_flags.contains(UpdateFlags::LOCALE) {
        tray::Tray::global().update_menu().await?;
    }
    if update_flags.contains(UpdateFlags::LOG_LEVEL) {
        Logger::global().update_log_level(patch.get_log_level())?;
    }
    if update_flags.contains(UpdateFlags::LOG_FILE) {
        let log_max_size = patch.app_log_max_size.unwrap_or(128);
        let log_max_count = patch.app_log_max_count.unwrap_or(8);
        Logger::global().update_log_config(log_max_size, log_max_count).await?;
    }

    Ok(())
}

impl WorkrunPatch {
    fn get_log_level(&self) -> log::LevelFilter {
        match self.app_log_level.as_deref().map(str::to_lowercase).as_deref() {
            Some("silent") => log::LevelFilter::Off,
            Some("error") => log::LevelFilter::Error,
            Some("warn") => log::LevelFilter::Warn,
            Some("info") => log::LevelFilter::Info,
            Some("debug") => log::LevelFilter::Debug,
            Some("trace") => log::LevelFilter::Trace,
            _ => log::LevelFilter::Info,
        }
    }
}
