use crate::{
    logging,
    utils::{dirs, help, i18n, logging::Type},
};
use anyhow::Result;
use log::LevelFilter;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelProvider {
    Gemini,
    OpenAi,
    OpenAiStrict,
    Anthropic,
    DeepSeek,
    Groq,
    Ollama,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    pub provider: ModelProvider,
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::config::serialize_encrypted",
        deserialize_with = "crate::config::deserialize_encrypted"
    )]
    pub api_key: Option<String>,
}

fn default_model_profiles() -> Vec<ModelProfile> {
    [
        (
            "gemini-3.1-pro-preview",
            "Gemini 3.1 Pro Preview",
            ModelProvider::Gemini,
        ),
        (
            "gemini-3-flash-preview",
            "Gemini 3 Flash Preview",
            ModelProvider::Gemini,
        ),
        (
            "gemini-3.1-flash-lite-preview",
            "Gemini 3.1 Flash Lite Preview",
            ModelProvider::Gemini,
        ),
        ("gemini-2.5-pro", "Gemini 2.5 Pro", ModelProvider::Gemini),
        ("gemini-2.5-flash", "Gemini 2.5 Flash", ModelProvider::Gemini),
        ("gpt-5", "GPT-5", ModelProvider::OpenAi),
        ("gpt-5-mini", "GPT-5 Mini", ModelProvider::OpenAi),
        ("gpt-5-nano", "GPT-5 Nano", ModelProvider::OpenAi),
        ("gpt-4.1", "GPT-4.1", ModelProvider::OpenAi),
        ("claude-opus-4-7", "Claude Opus 4.7", ModelProvider::Anthropic),
        ("claude-opus-4-6", "Claude Opus 4.6", ModelProvider::Anthropic),
        ("claude-sonnet-4-6", "Claude Sonnet 4.6", ModelProvider::Anthropic),
        (
            "claude-haiku-4-5-20251001",
            "Claude Haiku 4.5",
            ModelProvider::Anthropic,
        ),
        ("claude-opus-4-20250514", "Claude Opus 4", ModelProvider::Anthropic),
        ("claude-sonnet-4-20250514", "Claude Sonnet 4", ModelProvider::Anthropic),
        ("deepseek-r1-0528", "DeepSeek R1 0528", ModelProvider::DeepSeek),
        ("deepseek-r1", "DeepSeek R1", ModelProvider::DeepSeek),
        ("deepseek-v3.1", "DeepSeek V3.1", ModelProvider::DeepSeek),
        ("deepseek-chat", "DeepSeek Chat", ModelProvider::DeepSeek),
        ("deepseek-vl2", "DeepSeek VL2", ModelProvider::DeepSeek),
        ("llama-4-scout", "Llama 4 Scout", ModelProvider::Groq),
        (
            "llama-3.2-90b-text-preview",
            "Llama 3.2 90B Text Preview",
            ModelProvider::Groq,
        ),
        (
            "llama-3.1-70b-versatile",
            "Llama 3.1 70B Versatile",
            ModelProvider::Groq,
        ),
        ("llama-3.1-8b-instant", "Llama 3.1 8B Instant", ModelProvider::Groq),
        ("mixtral-8x7b-32768", "Mixtral 8x7B", ModelProvider::Groq),
    ]
    .into_iter()
    .map(|(model, name, provider)| ModelProfile {
        id: format!("{provider:?}-{model}").to_lowercase(),
        name: name.to_string(),
        provider,
        model: model.to_string(),
        base_url: None,
        api_key: None,
    })
    .collect()
}

/// Workrun configuration
/// ### `workrun.yaml` schema
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IWorkrun {
    #[serde(default = "default_model_profiles")]
    pub model_profiles: Vec<ModelProfile>,
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

impl Default for IWorkrun {
    fn default() -> Self {
        Self {
            model_profiles: default_model_profiles(),
            app_log_level: None,
            app_log_max_size: None,
            app_log_max_count: None,
            locale: None,
            theme: None,
            enable_auto_launch: None,
            enable_silent_start: None,
            auto_check_update: None,
            auto_log_clean: None,
        }
    }
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
