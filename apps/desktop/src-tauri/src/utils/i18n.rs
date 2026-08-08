pub const DEFAULT_LANGUAGE: &str = "en";

pub fn get_supported_languages() -> Vec<&'static str> {
    vec!["en", "zh-CN"]
}

#[derive(Debug)]
pub enum Locale {
    En,
    ZhCn,
}

impl Locale {
    pub fn from_str(locale: Option<&str>) -> Self {
        match locale {
            Some("zh-CN") => Locale::ZhCn,
            _ => Locale::En,
        }
    }

    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::ZhCn => "zh-CN",
        }
    }
}

fn tr_en(key: &str) -> &str {
    match key {
        "menu.dashboard" => "Open Workrun",
        "menu.open_config_dir" => "Config Directory",
        "menu.open_logs_dir" => "Logs Directory",
        "menu.open_dir" => "Open Directory",
        "menu.open_dev_tools" => "Open Dev Tools",
        "menu.about" => "About Workrun",
        "menu.quit" => "Quit Workrun",
        _ => key,
    }
}

fn tr_zh_cn(key: &str) -> &str {
    match key {
        "menu.dashboard" => "打开 Workrun",
        "menu.open_config_dir" => "配置目录",
        "menu.open_logs_dir" => "日志目录",
        "menu.open_dir" => "打开目录",
        "menu.open_dev_tools" => "打开开发者工具",
        "menu.about" => "关于 Workrun",
        "menu.quit" => "退出 Workrun",
        _ => key,
    }
}

pub fn tr<'a>(locale: &Locale, key: &'a str) -> &'a str {
    match locale {
        Locale::En => tr_en(key),
        Locale::ZhCn => tr_zh_cn(key),
    }
}
