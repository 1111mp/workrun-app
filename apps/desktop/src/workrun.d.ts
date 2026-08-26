type AppBaseTheme = 'light' | 'dark';
type AppTheme = AppBaseTheme | 'system';

type AppLocale = 'en' | 'zh-CN';
type WorkspaceMode = 'personal' | 'team';

type LocalProfile = {
  display_name: string;
  avatar_id: string;
};

type TeamSettings = {
  server_url: string;
};

type ModelProvider =
  | 'gemini'
  | 'open_ai'
  | 'open_ai_strict'
  | 'anthropic'
  | 'deep_seek'
  | 'groq'
  | 'ollama';

type ModelDefinition = {
  id: string;
  name: string;
  provider: ModelProvider;
  model: string;
};

type ProviderCredential = {
  provider: ModelProvider;
  baseUrl?: string;
  apiKey?: string;
};

interface IWorkrunConfig {
  workspace_mode?: WorkspaceMode;
  onboarding_completed?: boolean;
  local_profile?: LocalProfile;
  team?: TeamSettings;
  locale?: AppLocale;
  theme: AppTheme;
  enable_auto_launch?: boolean;
  enable_silent_start?: boolean;
  auto_check_update?: boolean;
  // log
  app_log_level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
  app_log_max_size?: number;
  app_log_max_count?: number;
  auto_log_clean?: 0 | 1 | 2 | 3 | 4;
  // model profile
  provider_credentials?: ProviderCredential[];
}
