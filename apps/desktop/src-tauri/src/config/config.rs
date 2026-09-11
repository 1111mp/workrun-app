use super::Draft;
use crate::{
    config::{IMcpServers, IProcessNodes, IWorkflows},
    logging, logging_error,
    process::AsyncHandler,
    utils::logging::Type,
};
use tokio::sync::OnceCell;

pub struct Config {
    workflow_config: Draft<IWorkflows>,
    process_node_config: Draft<IProcessNodes>,
    team_process_node_config: Draft<IProcessNodes>,
    mcp_server_config: Draft<IMcpServers>,
}

impl Config {
    pub async fn global() -> &'static Self {
        static CONFIG: OnceCell<Config> = OnceCell::const_new();
        CONFIG
            .get_or_init(|| async {
                let mut process_nodes = IProcessNodes::new().await;
                let mut team_process_nodes = IProcessNodes::new_team_releases().await;
                migrate_team_release_cache(&mut process_nodes, &mut team_process_nodes).await;
                Self {
                    workflow_config: Draft::new(IWorkflows::new().await),
                    process_node_config: Draft::new(process_nodes),
                    team_process_node_config: Draft::new(team_process_nodes),
                    mcp_server_config: Draft::new(IMcpServers::new().await),
                }
            })
            .await
    }

    pub async fn workflows() -> Draft<IWorkflows> {
        Self::global().await.workflow_config.clone()
    }

    pub async fn process_nodes() -> Draft<IProcessNodes> {
        Self::global().await.process_node_config.clone()
    }

    pub async fn team_process_nodes() -> Draft<IProcessNodes> {
        Self::global().await.team_process_node_config.clone()
    }

    pub async fn mcp_servers() -> Draft<IMcpServers> {
        Self::global().await.mcp_server_config.clone()
    }

    /// Reloads catalog snapshots after the active workspace directory changes.
    pub async fn reload_workspace() {
        let config = Self::global().await;
        config.workflow_config.replace(IWorkflows::new().await);
        let mut process_nodes = IProcessNodes::new().await;
        let mut team_process_nodes = IProcessNodes::new_team_releases().await;
        migrate_team_release_cache(&mut process_nodes, &mut team_process_nodes).await;
        config.process_node_config.replace(process_nodes);
        config.team_process_node_config.replace(team_process_nodes);
        config.mcp_server_config.replace(IMcpServers::new().await);
    }

    pub async fn apply_all_and_save_file() {
        logging!(info, Type::Config, "save all draft data");

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

        let save_team_process_node_task = AsyncHandler::spawn(|| async {
            let process_nodes = Self::team_process_nodes().await;
            process_nodes.apply();
            logging_error!(Type::Config, process_nodes.data_arc().save_team_releases_file().await);
        });

        let save_mcp_server_task = AsyncHandler::spawn(|| async {
            let mcp_server = Self::mcp_servers().await;
            mcp_server.apply();
            logging_error!(Type::Config, mcp_server.data_arc().save_file().await);
        });

        let _ = tokio::join!(
            save_workflow_task,
            save_process_node_task,
            save_team_process_node_task,
            save_mcp_server_task
        );

        logging!(info, Type::Config, "save all draft data finished");
    }
}

async fn migrate_team_release_cache(process_nodes: &mut IProcessNodes, team_process_nodes: &mut IProcessNodes) {
    let legacy_nodes = process_nodes.team_release_nodes();
    if legacy_nodes.is_empty() {
        return;
    }

    let mut migrated_team_nodes = team_process_nodes.clone();
    for node in legacy_nodes {
        if !migrated_team_nodes.has_team_release(&node) {
            migrated_team_nodes.add_process_node(node);
        }
    }
    // Save the new registry before removing legacy entries so interrupted
    // startup can always recover the downloaded release metadata.
    if let Err(error) = migrated_team_nodes.save_team_releases_file().await {
        logging!(error, Type::Config, "failed to migrate Team App releases: {error}");
        return;
    }

    let mut migrated_process_nodes = process_nodes.clone();
    migrated_process_nodes.remove_team_release_nodes();
    if let Err(error) = migrated_process_nodes.save_file().await {
        logging!(
            error,
            Type::Config,
            "failed to remove migrated Team App releases: {error}"
        );
        return;
    }
    *process_nodes = migrated_process_nodes;
    *team_process_nodes = migrated_team_nodes;
}
