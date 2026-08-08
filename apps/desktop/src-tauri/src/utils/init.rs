use crate::{
    config::{Config, IWorkrun},
    logging,
    process::AsyncHandler,
    utils::{
        dirs::{self, PathBufExec as _},
        help,
        logging::Type,
    },
};
use anyhow::Result;
use chrono::{Local, TimeZone as _};
use tokio::fs;

pub async fn delete_log() -> Result<()> {
    let log_dir = dirs::app_logs_dir()?;
    if !log_dir.exists() {
        return Ok(());
    }

    let auto_log_clean = {
        let workrun_draft = Config::workrun().await;
        let workrun = workrun_draft.data_arc();
        workrun.auto_log_clean.unwrap_or(0)
    };
    let day = match auto_log_clean {
        1 => 1,
        2 => 7,
        3 => 30,
        4 => 90,
        _ => return Ok(()),
    };

    logging!(info, Type::Setup, "try to delete log files, day: {day}");

    // %Y-%m-%d to NaiveDateTime
    let parse_time_str = |s: &str| {
        chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d_%H-%M-%S")
            .map_err(|e| anyhow::anyhow!("invalid time str: {e}"))
    };

    let mut dir = fs::read_dir(log_dir).await?;
    while let Some(entry) = dir.next_entry().await? {
        let file_name = entry.file_name();
        let file_name = match file_name.to_str() {
            Some(s) => s,
            None => continue,
        };
        if file_name == "workrun.log" {
            continue;
        }

        if file_name.ends_with(".log") {
            let now = Local::now();
            let created_time = parse_time_str(&file_name[0..file_name.len() - 4])?;
            let file_time = Local
                .from_local_datetime(&created_time)
                .single()
                .ok_or_else(|| anyhow::anyhow!("invalid local datetime"))?;

            let duration = now.signed_duration_since(file_time);
            if duration.num_days() > day {
                let _ = entry.path().remove_if_exists().await;
                logging!(info, Type::Setup, "delete log file: {}", file_name);
            }
        }
    }

    Ok(())
}

async fn ensure_directories() -> Result<()> {
    let directories = [
        ("app_home", dirs::app_home_dir()?),
        // ("file_upload", dirs::file_upload_dir()?),
        ("app_logs", dirs::app_logs_dir()?),
    ];

    for (name, dir) in directories {
        if !dir.exists() {
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to create {} directory {:?}: {}", name, dir, e))?;
            logging!(info, Type::Setup, "Created {} directory: {:?}", name, dir);
        }
    }

    Ok(())
}

async fn initialize_config_files() -> Result<()> {
    if let Ok(path) = dirs::workrun_path()
        && !path.exists()
    {
        let template = IWorkrun::template();
        help::save_yaml(&path, &template, Some("# Workrun Config File"))
            .await
            .map_err(|e| anyhow::anyhow!("Failed to create workrun config: {}", e))?;
        logging!(info, Type::Setup, "Created workrun config at {:?}", path);
    }

    Ok(())
}

/// Initialize all the config files before tauri setup
pub async fn init_config() -> Result<()> {
    ensure_directories().await?;

    initialize_config_files().await?;

    AsyncHandler::spawn(|| async {
        if let Err(e) = delete_log().await {
            logging!(warn, Type::Setup, "Failed to clean old logs: {}", e);
        }
        logging!(info, Type::Setup, "Background log cleanup task has completed");
    });

    Ok(())
}
