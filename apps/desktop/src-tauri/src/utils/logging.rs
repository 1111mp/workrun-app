use std::fmt;

use flexi_logger::{DeferredNow, filter::LogLineFilter};
use log::Record;

#[derive(Debug, PartialEq, Eq)]
pub enum Type {
    Cmd,
    Core,
    Config,
    Setup,
    System,
    Service,
    Hotkey,
    Window,
    Tray,
    Timer,
    Frontend,
    Backup,
    File,
    Lightweight,
    Network,
    ProxyMode,
    Server,
    Workrun,
}

impl fmt::Display for Type {
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cmd => write!(f, "[Cmd]"),
            Self::Core => write!(f, "[Core]"),
            Self::Config => write!(f, "[Config]"),
            Self::Setup => write!(f, "[Setup]"),
            Self::System => write!(f, "[System]"),
            Self::Service => write!(f, "[Service]"),
            Self::Hotkey => write!(f, "[Hotkey]"),
            Self::Window => write!(f, "[Window]"),
            Self::Tray => write!(f, "[Tray]"),
            Self::Timer => write!(f, "[Timer]"),
            Self::Frontend => write!(f, "[Frontend]"),
            Self::Backup => write!(f, "[Backup]"),
            Self::File => write!(f, "[File]"),
            Self::Lightweight => write!(f, "[Lightweight]"),
            Self::Network => write!(f, "[Network]"),
            Self::ProxyMode => write!(f, "[ProxMode]"),
            Self::Server => write!(f, "[Server]"),
            Self::Workrun => write!(f, "[Workrun]"),
        }
    }
}

#[macro_export]
macro_rules! logging {
    // Handle Result<T, E>
    ($level:ident, $type:expr, $($arg:tt)*) => {
        log::$level!(target: "app", "{} {}", $type, format_args!($($arg)*))
    };
}

#[macro_export]
macro_rules! logging_error {
    // Handle Result<T, E>
    ($type:expr, $expr:expr) => {
        if let Err(err) = $expr {
            log::error!(target: "app", "[{}] {}", $type, err);
        }
    };

    // Handle formatted message: always print to stdout and log as error
    ($type:expr, $fmt:literal $(, $arg:expr)*) => {
        log::error!(target: "app", "[{}] {}", $type, format_args!($fmt $(, $arg)*));
    };
}

pub struct ModuleFilter<'a> {
    block: Vec<&'a str>,
    exclude: Option<Vec<&'a str>>,
}

impl<'a> ModuleFilter<'a> {
    pub fn new(block: Vec<&'a str>, exclude: Option<Vec<&'a str>>) -> Self {
        Self { block, exclude }
    }

    #[inline]
    pub fn filter(&self, record: &Record) -> bool {
        let Some(module) = record.module_path() else {
            return true;
        };

        // Exclude modules that start with any of the exclude patterns
        if let Some(excludes) = &self.exclude
            && excludes.iter().any(|e| module.starts_with(e))
        {
            return true;
        }

        // Block modules that start with any of the block patterns
        !self.block.iter().any(|b| module.starts_with(b))
    }
}

impl<'a> LogLineFilter for ModuleFilter<'a> {
    #[inline]
    fn write(
        &self,
        now: &mut DeferredNow,
        record: &Record,
        writer: &dyn flexi_logger::filter::LogLineWriter,
    ) -> std::io::Result<()> {
        if !self.filter(record) {
            return Ok(());
        }
        writer.write(now, record)
    }
}
