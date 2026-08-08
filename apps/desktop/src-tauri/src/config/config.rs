use super::{Draft, IWorkrun};
use crate::{logging, logging_error, process::AsyncHandler, utils::logging::Type};
use tokio::sync::OnceCell;

pub struct Config {
    workrun_config: Draft<IWorkrun>,
}

impl Config {
    pub async fn global() -> &'static Self {
        static CONFIG: OnceCell<Config> = OnceCell::const_new();
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

    pub async fn apply_all_and_save_file() {
        logging!(info, Type::Config, "save all draft data");

        let save_workrun_task = AsyncHandler::spawn(|| async {
            let workrun = Self::workrun().await;
            workrun.apply();
            logging_error!(Type::Config, workrun.data_arc().save_config().await);
        });

        let _ = tokio::join!(save_workrun_task);

        logging!(info, Type::Config, "save all draft data finished");
    }
}
