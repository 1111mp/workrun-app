use crate::config::BaseConfig;
use anyhow::Result;
use tracing_subscriber::{
    filter::{LevelFilter, Targets},
    layer::{Layer as _, SubscriberExt as _},
};

static CAPTURE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub(crate) fn capture_content() -> bool {
    CAPTURE.load(std::sync::atomic::Ordering::Relaxed)
}
const SERVICE_NAME: &str = "workrun-desktop";

/// Enables developer telemetry only when an explicit collector endpoint is configured.
/// Workrun's durable run history remains local; OTLP is a diagnostic export and
/// must never make a workflow dependent on a reachable remote service.
pub async fn init() -> Result<()> {
    let config = BaseConfig::workrun().await.data_arc();
    CAPTURE.store(
        config.otlp_capture_content.unwrap_or(false),
        std::sync::atomic::Ordering::Relaxed,
    );
    let endpoint = config.otlp_endpoint.clone();
    let Some(endpoint) = configured_endpoint(endpoint) else {
        return Ok(());
    };

    let telemetry = subscriber(&endpoint)
        .and_then(|subscriber| tracing::subscriber::set_global_default(subscriber).map_err(Into::into));

    if let Err(error) = telemetry {
        // OTLP is a developer diagnostic. A malformed endpoint must not stop
        // the desktop application from starting or make local runs unavailable.
        log::warn!("Could not initialize OTLP telemetry: {error}");
    } else {
        log::info!("OTLP telemetry enabled for {SERVICE_NAME}");
    }
    Ok(())
}

pub(crate) fn subscriber(endpoint: &str) -> Result<impl tracing::Subscriber + Send + Sync> {
    // Preserve the application logger; ADK owns the only provider/exporter.
    let filter = Targets::new()
        .with_target("workrun_lib", LevelFilter::INFO)
        .with_target("adk_", LevelFilter::INFO);
    let layer = adk_telemetry::build_otlp_layer::<tracing_subscriber::Registry>(SERVICE_NAME, endpoint)?;
    Ok(tracing_subscriber::registry()
        .with(
            layer
                .with_filter(filter)
                .with_filter(tracing_subscriber::filter::filter_fn(|m| {
                    !m.target().starts_with("adk_")
                        || !matches!(
                            m.name(),
                            "call_llm"
                                | "run"
                                | "agent.execute"
                                | "model.generate_content"
                                | "execute_stream"
                                | "generate_content_stream"
                        )
                })),
        )
        .with(super::telemetry_langfuse::NativeAdapter::default()))
}
#[cfg(test)]
pub(crate) fn test_capture(value: bool) {
    CAPTURE.store(value, std::sync::atomic::Ordering::Relaxed);
}

/// Standard W3C traceparent, stored once in the existing run runtime.
/// No live span registry is needed across pauses or process restarts.
pub(crate) async fn workflow_parent(
    pool: &sqlx::SqlitePool,
    run_id: &str,
    runtime: &serde_json::Value,
    span: &tracing::Span,
) {
    use opentelemetry::trace::{SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState};
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    if let Some(header) = runtime
        .pointer("/observability/traceparent")
        .and_then(serde_json::Value::as_str)
    {
        let parts = header.split('-').collect::<Vec<_>>();
        if parts.len() == 4
            && parts[0] == "00"
            && let (Ok(trace), Ok(id), Ok(flags)) = (
                TraceId::from_hex(parts[1]),
                SpanId::from_hex(parts[2]),
                u8::from_str_radix(parts[3], 16),
            )
        {
            let parent = SpanContext::new(trace, id, TraceFlags::new(flags), true, TraceState::default());
            if parent.is_valid() {
                let _ = span.set_parent(opentelemetry::Context::new().with_remote_span_context(parent));
                return;
            }
        }
    }
    let context = span.context();
    let sc = context.span().span_context().clone();
    if !sc.is_valid() {
        return;
    }
    {
        let header = format!("00-{}-{}-{:02x}", sc.trace_id(), sc.span_id(), sc.trace_flags().to_u8());
        // Attribution is best effort; a tracing failure cannot fail execution.
        if let Err(error) = sqlx::query(
            "UPDATE run_records SET runtime_json=json_set(runtime_json,'$.observability.traceparent',?) WHERE id=?",
        )
        .bind(header)
        .bind(run_id)
        .execute(pool)
        .await
        {
            log::warn!("Could not save workflow trace context: {error}");
        }
    }
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

#[cfg(test)]
mod native_probe {
    use adk_rust::{Content, LlmRequest};
    use futures::StreamExt;
    use tracing::{Instrument, instrument::WithSubscriber};

    #[tokio::test]
    #[ignore = "requires local Collector/Langfuse; local HTTP model fixture only"]
    async fn export_native_adk_model() {
        use adk_rust::model::openai::{OpenAICompatible, OpenAICompatibleConfig};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                .map(|(_, v)| v.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\ndata: [DONE]\n\n";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let subscriber = super::subscriber("http://127.0.0.1:4317").unwrap();
        super::CAPTURE.store(true, std::sync::atomic::Ordering::Relaxed);
        let probe = uuid::Uuid::new_v4().to_string();
        println!("native_probe={probe}");
        async {
            let root = tracing::info_span!("native.adk.probe", "langfuse.observation.type"="chain", "langfuse.environment"="test", "langfuse.session.id"=%probe);
            async {
                let model = OpenAICompatible::new(OpenAICompatibleConfig::new("fixture", "workrun-native-probe").with_base_url(format!("http://{address}"))).unwrap();
                let context=crate::module::model_usage::CallContext{session_id:Some(probe.clone()),purpose:"native-probe".into(),..Default::default()};
                let (_,mut stream) = crate::module::model_usage::observe(&model,LlmRequest::new("workrun-native-probe", vec![Content::new("user").with_text("reply ok")]),true,context).await.unwrap();
                let mut usage = None;
                while let Some(response) = stream.next().await {
                    if let Some(value) = response.unwrap().usage_metadata { usage = Some(value); }
                }
                assert_eq!(usage.unwrap().total_token_count, 7);
            }.instrument(root).await;
        }.with_subscriber(subscriber).await;
        server.await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    }
}
