#![allow(unused)]

use crate::{
    logging, singleton,
    utils::{
        dirs,
        logging::{ModuleFilter, Type},
    },
};
use anyhow::{Result, bail};
use flexi_logger::{
    Cleanup, Criterion, FileSpec, LogSpecBuilder, LogSpecification, LoggerHandle, Naming,
    writers::{FileLogWriter, FileLogWriterBuilder},
};
use log::LevelFilter;
use parking_lot::{Mutex, RwLock};
use std::{
    str::FromStr as _,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};

pub struct Logger {
    handle: Arc<Mutex<Option<LoggerHandle>>>,
    log_level: Arc<RwLock<LevelFilter>>,
    log_max_size: AtomicU64,
    log_max_count: AtomicUsize,
}

impl Default for Logger {
    fn default() -> Self {
        Self {
            handle: Arc::new(Mutex::new(None)),
            log_level: Arc::new(RwLock::new(LevelFilter::Info)),
            log_max_size: AtomicU64::new(128),
            log_max_count: AtomicUsize::new(8),
        }
    }
}

singleton!(Logger, LOGGER);

impl Logger {
    fn new() -> Self {
        Self::default()
    }

    pub async fn init(&self) -> Result<()> {
        let (log_level, log_max_size, log_max_count) = {
            let workrun_draft = crate::config::Config::workrun().await;
            let workrun = workrun_draft.latest_arc();
            (
                workrun.get_log_level(),
                workrun.app_log_max_size.unwrap_or(128),
                workrun.app_log_max_count.unwrap_or(8),
            )
        };
        let log_level = std::env::var("RUST_LOG")
            .ok()
            .and_then(|v| log::LevelFilter::from_str(&v).ok())
            .unwrap_or(log_level);
        *self.log_level.write() = log_level;
        self.log_max_size.store(log_max_size, Ordering::SeqCst);
        self.log_max_count.store(log_max_count, Ordering::SeqCst);

        #[cfg(not(any(feature = "tauri-dev", feature = "tokio-trace")))]
        {
            let log_spec = Self::generate_log_spec(log_level);
            let log_dir = dirs::app_logs_dir()?;
            let logger = flexi_logger::Logger::with(log_spec)
                .log_to_file(FileSpec::default().directory(log_dir).basename(""))
                .duplicate_to_stdout(log_level.into())
                .format(flexi_logger::colored_with_thread)
                .format_for_files(flexi_logger::detailed_format)
                .rotate(
                    Criterion::Size(log_max_size * 1024),
                    Naming::TimestampsCustomFormat {
                        current_infix: Some("workrun"),
                        format: "%Y-%m-%d_%H-%M-%S",
                    },
                    Cleanup::KeepLogFiles(log_max_count),
                );

            let mut filter_modules = vec!["wry"];
            #[cfg(not(feature = "tracing"))]
            filter_modules.push("tauri");
            let logger = logger.filter(Box::new(ModuleFilter::new(filter_modules, None)));

            let handle = logger.start()?;
            *self.handle.lock() = Some(handle);
        }

        std::panic::set_hook(Box::new(move |info| {
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .unwrap_or(&"Unknown panic payload");
            let location = info
                .location()
                .map(|loc| format!("{}:{}", loc.file(), loc.line()))
                .unwrap_or_else(|| "Unknown location".to_string());
            logging!(error, Type::System, "Panic occurred at {}: {}", location, payload);
            if let Some(h) = Self::global().handle.lock().as_ref() {
                h.flush();
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }));

        Ok(())
    }

    /// only update app log level
    pub fn update_log_level(&self, level: LevelFilter) -> Result<()> {
        *self.log_level.write() = level;
        let log_level = self.log_level.read().to_owned();
        if let Some(handle) = self.handle.lock().as_mut() {
            let log_spec = Self::generate_log_spec(log_level);
            handle.set_new_spec(log_spec);
            handle.adapt_duplication_to_stdout(log_level.into())?;
        } else {
            bail!("failed to get logger handle, make sure it init");
        };
        Ok(())
    }

    /// only update app log config
    pub async fn update_log_config(&self, log_max_size: u64, log_max_count: usize) -> Result<()> {
        self.log_max_size.store(log_max_size, Ordering::SeqCst);
        self.log_max_count.store(log_max_count, Ordering::SeqCst);
        if let Some(handle) = self.handle.lock().as_ref() {
            let log_file_writer = self.generate_file_log_writer()?;
            handle.reset_flw(&log_file_writer)?;
        } else {
            bail!("failed to get logger handle, make sure it init");
        };

        Ok(())
    }

    fn generate_log_spec(log_level: LevelFilter) -> LogSpecification {
        let mut spec = LogSpecBuilder::new();
        let log_level = std::env::var("RUST_LOG")
            .ok()
            .and_then(|v| log::LevelFilter::from_str(&v).ok())
            .unwrap_or(log_level);
        spec.default(log_level);
        #[cfg(feature = "tracing")]
        spec.module("tauri", log::LevelFilter::Debug)
            .module("wry", log::LevelFilter::Off);
        spec.build()
    }

    fn generate_file_log_writer(&self) -> Result<FileLogWriterBuilder> {
        let log_dir = dirs::app_logs_dir()?;
        let log_max_size = self.log_max_size.load(Ordering::SeqCst);
        let log_max_count = self.log_max_count.load(Ordering::SeqCst);
        let flwb = FileLogWriter::builder(FileSpec::default().directory(log_dir).basename("")).rotate(
            Criterion::Size(log_max_size * 1024),
            flexi_logger::Naming::TimestampsCustomFormat {
                current_infix: Some("workrun"),
                format: "%Y-%m-%d_%H-%M-%S",
            },
            Cleanup::KeepLogFiles(log_max_count),
        );
        Ok(flwb)
    }
}
