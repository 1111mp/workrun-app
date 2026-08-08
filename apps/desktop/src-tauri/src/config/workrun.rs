use crate::{
    logging,
    utils::{dirs, help, i18n, logging::Type},
};
use anyhow::Result;
use log::LevelFilter;
use serde::{Deserialize, Serialize};

/// Workrun configuration
/// ### `workrun.yaml` schema
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct IWorkrun {
    /// app log level
    /// silent | error | warn | info | debug | trace
    pub app_log_level: Option<String>,

    /// app log max size in KB
    pub app_log_max_size: Option<u64>,

    /// app log max count
    pub app_log_max_count: Option<usize>,

    /// i18n
    pub locale: Option<String>,

    /// app theme
    /// `system` | `light` | `dark`
    pub theme: Option<String>,

    /// can the app auto startup
    pub enable_auto_launch: Option<bool>,

    /// not show the window on launch
    pub enable_silent_start: Option<bool>,

    /// Automatically check for updates
    pub auto_check_update: Option<bool>,

    /// Log CLeanup
    /// 0: No cleaning; 1: 1 day; 2: 7 days; 3: 30 days; 4: 90 days
    pub auto_log_clean: Option<i32>,
}

impl IWorkrun {
    pub async fn new() -> Self {
        match dirs::workrun_path() {
            Ok(path) => match help::read_yaml::<Self>(&path).await {
                Ok(config) => config,
                Err(err) => {
                    logging!(error, Type::Config, "{err}");
                    Self::template()
                },
            },
            Err(err) => {
                logging!(error, Type::Config, "{err}");
                Self::template()
            },
        }
    }

    pub fn template() -> Self {
        Self {
            app_log_max_size: Some(128),
            app_log_max_count: Some(8),
            locale: Some(Self::get_system_locale()),
            theme: Some("system".to_string()),
            enable_auto_launch: Some(false),
            enable_silent_start: Some(false),
            auto_check_update: Some(true),
            auto_log_clean: Some(2), // default to 7 day
            ..Self::default()
        }
    }

    /// Save Workrun App Config
    pub async fn save_config(&self) -> Result<()> {
        help::save_yaml(&dirs::workrun_path()?, &self, Some("# Workrun Config File")).await
    }

    /// patch workrun config
    /// only save to file
    pub fn patch_config(&mut self, patch: &Self) {
        macro_rules! patch {
            ($key: tt) => {
                if patch.$key.is_some() {
                    self.$key = patch.$key.clone();
                }
            };
        }

        patch!(app_log_level);
        patch!(app_log_max_size);
        patch!(app_log_max_count);
        patch!(locale);
        patch!(theme);
        patch!(enable_auto_launch);
        patch!(enable_silent_start);
        patch!(auto_check_update);
        patch!(auto_log_clean);
    }

    /// get app log level
    pub fn get_log_level(&self) -> LevelFilter {
        if let Some(level) = self.app_log_level.as_ref() {
            match level.to_lowercase().as_str() {
                "silent" => LevelFilter::Off,
                "error" => LevelFilter::Error,
                "warn" => LevelFilter::Warn,
                "info" => LevelFilter::Info,
                "debug" => LevelFilter::Debug,
                "trace" => LevelFilter::Trace,
                _ => LevelFilter::Info, // default to Info if not recognized
            }
        } else {
            LevelFilter::Info // default log level
        }
    }

    fn get_system_locale() -> String {
        let sys_lang = sys_locale::get_locale().unwrap_or_else(|| i18n::DEFAULT_LANGUAGE.to_string());
        let supported_languages = i18n::get_supported_languages();
        if supported_languages.contains(&sys_lang.as_str()) {
            return sys_lang;
        }

        let lang = sys_lang.replace('_', "-");
        if let Some(found) = supported_languages
            .iter()
            .find(|&&supported| lang.starts_with(supported))
        {
            return found.to_string();
        }

        let lang_code = lang.split('-').next().unwrap_or(i18n::DEFAULT_LANGUAGE);
        match lang_code {
            "zh" => "zh-CN".to_string(),
            "en" => "en".to_string(),
            _ => i18n::DEFAULT_LANGUAGE.to_string(),
        }
    }
}
