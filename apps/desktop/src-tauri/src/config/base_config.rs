use super::{Draft, IWorkrun};
use crate::{logging, logging_error, utils::logging::Type};
use tokio::sync::OnceCell;

/// Installation-wide configuration loaded before an active workspace exists.
pub struct BaseConfig {
    workrun_config: Draft<IWorkrun>,
}

impl BaseConfig {
    pub async fn global() -> &'static Self {
        static CONFIG: OnceCell<BaseConfig> = OnceCell::const_new();
        CONFIG
            .get_or_init(|| async {
                Self {
                    workrun_config: Draft::new(IWorkrun::new().await),
                }
            })
            .await
    }

    pub async fn workrun() -> Draft<IWorkrun> {
        Self::global().await.workrun_config.clone()
    }

    pub async fn apply_and_save_file() {
        logging!(info, Type::Config, "save base configuration");
        let workrun = Self::workrun().await;
        workrun.apply();
        logging_error!(Type::Config, workrun.data_arc().save_config().await);
    }
}
