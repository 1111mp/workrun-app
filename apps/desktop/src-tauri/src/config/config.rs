use super::{Draft, IWorkrun};
use crate::{
    config::{IMcpServers, IProcessNodes, IWorkflows},
    logging, logging_error,
    process::AsyncHandler,
    utils::logging::Type,
};
use tokio::sync::OnceCell;

pub struct Config {
    workrun_config: Draft<IWorkrun>,
    workflow_config: Draft<IWorkflows>,
    process_node_config: Draft<IProcessNodes>,
    mcp_server_config: Draft<IMcpServers>,
}

impl Config {
    pub async fn global() -> &'static Self {
        static CONFIG: OnceCell<Config> = OnceCell::const_new();
        CONFIG
            .get_or_init(|| async {
                Self {
                    workrun_config: Draft::new(IWorkrun::new().await),
                    workflow_config: Draft::new(IWorkflows::new().await),
                    process_node_config: Draft::new(IProcessNodes::new().await),
                    mcp_server_config: Draft::new(IMcpServers::new().await),
                }
            })
            .await
    }

    pub async fn workrun() -> Draft<IWorkrun> {
        Self::global().await.workrun_config.clone()
    }

    pub async fn workflows() -> Draft<IWorkflows> {
        Self::global().await.workflow_config.clone()
    }

    pub async fn process_nodes() -> Draft<IProcessNodes> {
        Self::global().await.process_node_config.clone()
    }

    pub async fn mcp_servers() -> Draft<IMcpServers> {
        Self::global().await.mcp_server_config.clone()
    }

    pub async fn apply_all_and_save_file() {
        logging!(info, Type::Config, "save all draft data");

        let save_workrun_task = AsyncHandler::spawn(|| async {
            let workrun = Self::workrun().await;
            workrun.apply();
            logging_error!(Type::Config, workrun.data_arc().save_config().await);
        });

        let save_workflow_task = AsyncHandler::spawn(|| async {
            let workflow = Self::workflows().await;
            workflow.apply();
            logging_error!(Type::Config, workflow.data_arc().save_file().await);
        });

        let save_process_node_task = AsyncHandler::spawn(|| async {
            let process_node = Self::process_nodes().await;
            process_node.apply();
            logging_error!(Type::Config, process_node.data_arc().save_file().await);
        });

        let save_mcp_server_task = AsyncHandler::spawn(|| async {
            let mcp_server = Self::mcp_servers().await;
            mcp_server.apply();
            logging_error!(Type::Config, mcp_server.data_arc().save_file().await);
        });

        let _ = tokio::join!(
            save_workrun_task,
            save_workflow_task,
            save_process_node_task,
            save_mcp_server_task
        );

        logging!(info, Type::Config, "save all draft data finished");
    }
}
