use crate::config::BaseConfig;
use anyhow::Result;
use tracing_subscriber::{
    filter::{LevelFilter, Targets},
    layer::{Layer as _, SubscriberExt as _},
};

const SERVICE_NAME: &str = "workrun-desktop";

/// Enables developer telemetry only when an explicit collector endpoint is configured.
/// Workrun's durable run history remains local; OTLP is a diagnostic export and
/// must never make a workflow dependent on a reachable remote service.
pub async fn init() -> Result<()> {
    let endpoint = BaseConfig::workrun().await.data_arc().otlp_endpoint.clone();
    let Some(endpoint) = configured_endpoint(endpoint) else {
        return Ok(());
    };

    // Workrun installs flexi_logger first to retain its file rotation and runtime
    // configuration. `init_with_otlp` also installs LogTracer, which conflicts
    // with that process-wide logger, so only compose ADK's OTLP layer here.
    // This allowlist is applied only to OTLP: the local Workrun logger continues
    // recording every target, while transport and Tauri diagnostics stay local.
    let filter = Targets::new()
        .with_target("workrun_lib", LevelFilter::INFO)
        .with_target("adk_", LevelFilter::INFO);
    let telemetry =
        adk_telemetry::build_otlp_layer::<tracing_subscriber::Registry>(SERVICE_NAME, &endpoint).and_then(|layer| {
            tracing::subscriber::set_global_default(tracing_subscriber::registry().with(layer.with_filter(filter)))
                .map_err(|error| adk_telemetry::TelemetryError::Init(error.to_string()))
        });

    if let Err(error) = telemetry {
        // OTLP is a developer diagnostic. A malformed endpoint must not stop
        // the desktop application from starting or make local runs unavailable.
        log::warn!("Could not initialize OTLP telemetry: {error}");
    } else {
        log::info!("OTLP telemetry enabled for {SERVICE_NAME}");
    }
    Ok(())
}

/// Performs ADK's best-effort telemetry shutdown before the native process exits.
/// The current ADK batch exporter flushes periodically while the app is alive.
pub fn shutdown() {
    adk_telemetry::shutdown_telemetry();
}

fn configured_endpoint(value: Option<String>) -> Option<String> {
    value.and_then(|endpoint| {
        let endpoint = endpoint.trim();
        (!endpoint.is_empty()).then(|| endpoint.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::configured_endpoint;

    #[test]
    fn only_accepts_a_non_empty_otlp_endpoint() {
        assert_eq!(configured_endpoint(None), None);
        assert_eq!(configured_endpoint(Some("  ".into())), None);
        assert_eq!(
            configured_endpoint(Some(" http://localhost:4317 ".into())),
            Some("http://localhost:4317".into())
        );
    }
}
