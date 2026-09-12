use anyhow::Result;

const OTLP_ENDPOINT_ENV: &str = "WORKRUN_OTLP_ENDPOINT";
const SERVICE_NAME: &str = "workrun-desktop";

/// Enables developer telemetry only when an explicit collector endpoint is set.
/// Workrun's durable run history remains local; OTLP is a diagnostic export and
/// must never make a workflow dependent on a reachable remote service.
pub fn init() -> Result<()> {
    let Some(endpoint) = endpoint_from_env(std::env::var(OTLP_ENDPOINT_ENV).ok()) else {
        return Ok(());
    };

    if let Err(error) = adk_telemetry::init_with_otlp(SERVICE_NAME, &endpoint) {
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

fn endpoint_from_env(value: Option<String>) -> Option<String> {
    value.and_then(|endpoint| {
        let endpoint = endpoint.trim();
        (!endpoint.is_empty()).then(|| endpoint.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::{OTLP_ENDPOINT_ENV, SERVICE_NAME, endpoint_from_env};

    #[test]
    fn only_accepts_a_non_empty_otlp_endpoint() {
        assert_eq!(endpoint_from_env(None), None);
        assert_eq!(endpoint_from_env(Some("  ".into())), None);
        assert_eq!(
            endpoint_from_env(Some(" http://localhost:4317 ".into())),
            Some("http://localhost:4317".into())
        );
    }

    #[test]
    #[ignore = "requires a local OTLP collector selected with WORKRUN_OTLP_ENDPOINT"]
    fn exports_a_workflow_and_genai_span() {
        let endpoint = std::env::var(OTLP_ENDPOINT_ENV).expect("OTLP endpoint is required");

        // The exporter creates tonic tasks, so it must be initialized inside
        // Tauri's long-lived Tokio runtime just like the desktop application.
        tauri::async_runtime::block_on(async {
            adk_telemetry::init_with_otlp(SERVICE_NAME, &endpoint).expect("OTLP initializes");

            {
                let workflow = tracing::info_span!(
                    "workrun.workflow.run",
                    workrun.run.id = "telemetry-smoke-run",
                    workrun.workflow.id = "telemetry-smoke-workflow",
                    workrun.workflow.version = "test",
                    workrun.thread.id = "telemetry-smoke-thread",
                );
                let _workflow = workflow.enter();
                let model = adk_telemetry::llm_generate_span("smoke", "telemetry-smoke-model", false);
                let _model = model.enter();
                adk_telemetry::record_llm_usage(&adk_telemetry::LlmUsage {
                    input_tokens: 11,
                    output_tokens: 7,
                    total_tokens: 18,
                    cache_read_tokens: Some(3),
                    ..Default::default()
                });
            }

            // ADK configures a batch exporter. Keep the long-lived desktop
            // runtime alive for one collection cycle before inspecting Jaeger.
            tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        });

        adk_telemetry::shutdown_telemetry();
    }
}
