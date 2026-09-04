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

/// Static model metadata. This is the only model data exposed to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDefinition {
    pub id: String,
    pub name: String,
    pub provider: ModelProvider,
    pub model: String,
}

/// Per-provider user credential persisted in `workrun.yaml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredential {
    pub provider: ModelProvider,
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

pub fn credential_provider(provider: &ModelProvider) -> ModelProvider {
    match provider {
        ModelProvider::OpenAiStrict => ModelProvider::OpenAi,
        provider => provider.clone(),
    }
}

fn default_model_profiles() -> Vec<ModelProfile> {
    [
        ("gemini-3.7-flash", "Gemini 3.7 Flash", ModelProvider::Gemini),
        ("gemini-3.6-flash", "Gemini 3.6 Flash", ModelProvider::Gemini),
        ("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", ModelProvider::Gemini),
        (
            "gemini-3.1-pro-preview",
            "Gemini 3.1 Pro Preview",
            ModelProvider::Gemini,
        ),
        ("gpt-5.6-terra", "GPT-5.6 Terra", ModelProvider::OpenAi),
        ("gpt-5.6-sol", "GPT-5.6 Sol", ModelProvider::OpenAi),
        ("gpt-5.6-luna", "GPT-5.6 Luna", ModelProvider::OpenAi),
        ("gpt-5.6", "GPT-5.6", ModelProvider::OpenAi),
        ("claude-sonnet-5", "Claude Sonnet 5", ModelProvider::Anthropic),
        ("claude-opus-5", "Claude Opus 5", ModelProvider::Anthropic),
        ("claude-fable-5", "Claude Fable 5", ModelProvider::Anthropic),
        ("claude-haiku-4-5", "Claude Haiku 4.5", ModelProvider::Anthropic),
        ("deepseek-v4-flash", "DeepSeek V4 Flash", ModelProvider::DeepSeek),
        ("deepseek-v4-pro", "DeepSeek V4 Pro", ModelProvider::DeepSeek),
        ("openai/gpt-oss-120b", "GPT-OSS 120B", ModelProvider::Groq),
        ("openai/gpt-oss-20b", "GPT-OSS 20B", ModelProvider::Groq),
        // Keep one local profile available so Ollama can be used without a
        // cloud credential; users can point it at a remote Ollama host in Settings.
        ("llama3.2", "Llama 3.2 (Ollama)", ModelProvider::Ollama),
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

pub fn model_catalog() -> Vec<ModelDefinition> {
    default_model_profiles()
        .into_iter()
        .map(|profile| ModelDefinition {
            id: profile.id,
            name: profile.name,
            provider: profile.provider,
            model: profile.model,
        })
        .collect()
}

/// Selects whether this installation works independently or joins a team.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    Personal,
    Team,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalProfile {
    pub display_name: String,
    pub avatar_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamSettings {
    pub server_url: String,
}

/// Workrun configuration
/// ### `workrun.yaml` schema
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IWorkrun {
    /// Selected during first-run onboarding. `None` means onboarding is still required.
    pub workspace_mode: Option<WorkspaceMode>,

    #[serde(default)]
    pub onboarding_completed: bool,

    pub local_profile: Option<LocalProfile>,

    pub team: Option<TeamSettings>,

    #[serde(default)]
    pub provider_credentials: Vec<ProviderCredential>,
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

/// Partial Workrun configuration received from the frontend.
///
/// This is deliberately separate from `IWorkrun` so missing fields remain untouched.
#[derive(Debug, Clone, Deserialize)]
pub struct WorkrunPatch {
    pub workspace_mode: Option<WorkspaceMode>,
    pub onboarding_completed: Option<bool>,
    pub local_profile: Option<LocalProfile>,
    pub team: Option<TeamSettings>,
    pub provider_credentials: Option<Vec<ProviderCredential>>,
    pub app_log_level: Option<String>,
    pub app_log_max_size: Option<u64>,
    pub app_log_max_count: Option<usize>,
    pub locale: Option<String>,
    pub theme: Option<String>,
    pub enable_auto_launch: Option<bool>,
    pub enable_silent_start: Option<bool>,
    pub auto_check_update: Option<bool>,
    pub auto_log_clean: Option<i32>,
}

impl Default for IWorkrun {
    fn default() -> Self {
        Self {
            workspace_mode: None,
            onboarding_completed: false,
            local_profile: None,
            team: None,
            provider_credentials: Vec::new(),
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
            // First-run onboarding completes these fields with the selected mode.
            workspace_mode: None,
            onboarding_completed: false,
            local_profile: None,
            team: None,
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
    pub fn patch_config(&mut self, patch: &WorkrunPatch) {
        macro_rules! patch {
            ($key: tt) => {
                if patch.$key.is_some() {
                    self.$key = patch.$key.clone();
                }
            };
        }

        if let Some(credentials) = &patch.provider_credentials {
            for credential in credentials {
                let provider = credential_provider(&credential.provider);
                let mut credential = credential.clone();
                credential.provider = provider.clone();
                credential.api_key = credential.api_key.filter(|key| !key.trim().is_empty());
                credential.base_url = credential.base_url.filter(|url| !url.trim().is_empty());
                if let Some(existing) = self
                    .provider_credentials
                    .iter_mut()
                    .find(|item| item.provider == provider)
                {
                    *existing = credential;
                } else {
                    self.provider_credentials.push(credential);
                }
            }
        }

        patch!(workspace_mode);
        if let Some(onboarding_completed) = patch.onboarding_completed {
            self.onboarding_completed = onboarding_completed;
        }
        patch!(local_profile);
        patch!(team);
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

    pub fn credential_for(&self, provider: &ModelProvider) -> Option<&ProviderCredential> {
        let provider = credential_provider(provider);
        self.provider_credentials.iter().find(|item| item.provider == provider)
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
