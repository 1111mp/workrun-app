//! Scheduling boundaries share the existing exporter, redaction and content opt-in.
use crate::core::{telemetry, telemetry_langfuse::encoded};
use serde_json::Value;
use tracing::Span;

pub(crate) fn observation(name: &str, kind: &str, workspace: &str, session: &str) -> Span {
    let span = tracing::info_span!(
        "workrun.schedule",
        "otel.name" = name,
        "langfuse.trace.name" = tracing::field::Empty,
        "langfuse.observation.type" = kind,
        "langfuse.session.id" = session,
        "langfuse.user.id" = tracing::field::Empty,
        "langfuse.trace.metadata.userName" = tracing::field::Empty,
        "langfuse.trace.metadata.userEmail" = tracing::field::Empty,
        "langfuse.trace.metadata.server" = tracing::field::Empty,
        "langfuse.trace.metadata.workspaceMode" = tracing::field::Empty,
        "langfuse.environment" = if cfg!(test) {
            "test"
        } else if cfg!(debug_assertions) {
            "development"
        } else {
            "production"
        },
        "langfuse.observation.metadata.reason" = tracing::field::Empty,
        "langfuse.observation.metadata.workspaceId" = workspace,
        "langfuse.observation.metadata.scheduleId" = tracing::field::Empty,
        "langfuse.observation.metadata.proposalId" = tracing::field::Empty,
        "langfuse.observation.metadata.turnId" = tracing::field::Empty,
        "langfuse.observation.metadata.runId" = tracing::field::Empty,
        "langfuse.observation.metadata.occurrenceId" = tracing::field::Empty,
        "langfuse.observation.metadata.scheduledFor" = tracing::field::Empty,
        // A dropped future (stop/timeout) must not look like successful completion.
        "langfuse.observation.metadata.status" = "interrupted",
        "langfuse.observation.level" = tracing::field::Empty,
        "langfuse.observation.status_message" = tracing::field::Empty,
        "langfuse.observation.input" = tracing::field::Empty,
        "langfuse.observation.output" = tracing::field::Empty,
    );
    crate::core::telemetry_langfuse::record_user(&span);
    if kind != "tool" {
        span.record("langfuse.trace.name", name);
    }
    span
}

pub(crate) fn finish(span: &Span, status: &str, error: Option<&anyhow::Error>) {
    span.record("langfuse.observation.metadata.status", status);
    if let Some(error) = error {
        span.record("langfuse.observation.level", "ERROR");
        // Error messages can contain provider or target data too.
        if telemetry::capture_content() {
            span.record(
                "langfuse.observation.status_message",
                encoded(&serde_json::json!({"error":error.to_string()})),
            );
        }
    }
}

pub(crate) fn input(span: &Span, value: &Value) {
    if telemetry::capture_content() {
        span.record("langfuse.observation.input", encoded(value));
    }
}

pub(crate) fn output(span: &Span, value: &Value) {
    if telemetry::capture_content() {
        span.record("langfuse.observation.output", encoded(value));
    }
}

/// Persist the dispatch context before enqueueing: the supervisor may claim immediately.
pub(crate) fn traceparent(span: &Span) -> Option<String> {
    use opentelemetry::trace::TraceContextExt;
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    let context = span.context();
    let current = context.span();
    let sc = current.span_context();
    sc.is_valid()
        .then(|| format!("00-{}-{}-{:02x}", sc.trace_id(), sc.span_id(), sc.trace_flags().to_u8()))
}

pub(crate) fn restore_parent(span: &Span, header: Option<&str>) {
    use opentelemetry::trace::{SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState};
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    let Some(header) = header else {
        return;
    };
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
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use opentelemetry::trace::TracerProvider;
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};
    use tracing_subscriber::layer::SubscriberExt;

    pub(crate) fn exporter() -> (
        impl tracing::Subscriber + Send + Sync,
        InMemorySpanExporter,
        SdkTracerProvider,
    ) {
        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("schedule-tests")))
            .with(crate::core::telemetry_langfuse::NativeAdapter::default());
        (subscriber, exporter, provider)
    }

    pub(crate) fn attribute(span: &SpanData, name: &str) -> Option<String> {
        span.attributes
            .iter()
            .rev()
            .find(|a| a.key.as_str() == name)
            .map(|a| a.value.to_string())
    }

    #[test]
    fn dispatch_context_survives_serialization_and_background_execution() {
        let (subscriber, exporter, _provider) = exporter();
        tracing::subscriber::with_default(subscriber, || {
            let dispatch = observation("dispatch", "chain", "personal", "run-1");
            let trigger = crate::module::run_manager::ScheduleTrigger {
                schedule_id: "task-1".into(),
                scheduled_for: "2026-11-15T09:00:00Z".into(),
                occurrence_id: Some("occurrence-1".into()),
                traceparent: traceparent(&dispatch),
            };
            let wire = serde_json::to_value(trigger).unwrap();
            assert!(wire["traceparent"].as_str().unwrap().starts_with("00-"));
            finish(&dispatch, "queued", None);
            drop(dispatch);
            // No live parent span remains; queued runs restore only the stored header.
            let execute = observation("execute", "chain", "personal", "run-1");
            restore_parent(&execute, wire["traceparent"].as_str());
            finish(&execute, "failed", Some(&anyhow::anyhow!("fixture error")));
        });
        let spans = exporter.get_finished_spans().unwrap();
        let dispatch = spans.iter().find(|s| s.name == "dispatch").unwrap();
        let execute = spans.iter().find(|s| s.name == "execute").unwrap();
        assert_eq!(execute.span_context.trace_id(), dispatch.span_context.trace_id());
        assert_eq!(execute.parent_span_id, dispatch.span_context.span_id());
        assert_eq!(
            attribute(execute, "langfuse.observation.metadata.status").as_deref(),
            Some("failed")
        );
        assert_eq!(
            attribute(execute, "langfuse.observation.level").as_deref(),
            Some("ERROR")
        );
        let legacy: crate::module::run_manager::ScheduleTrigger =
            serde_json::from_value(serde_json::json!({"scheduleId":"old","scheduledFor":"now"})).unwrap();
        assert!(legacy.traceparent.is_none());
    }

    #[test]
    fn missing_or_invalid_context_and_disabled_telemetry_do_not_block_execution() {
        for header in [
            None,
            Some("broken"),
            Some("00-00000000000000000000000000000000-0000000000000000-01"),
        ] {
            restore_parent(&Span::none(), header);
        }
        assert!(traceparent(&Span::none()).is_none());
    }

    #[tokio::test]
    async fn cancelled_future_closes_observation_without_claiming_completion() {
        use tracing::{Instrument, instrument::WithSubscriber};
        let (subscriber, exporter, _provider) = exporter();
        async {
            let root = observation("turn", "agent", "personal", "session");
            let future = async {
                let tool = observation("slow tool", "tool", "personal", "session");
                std::future::pending::<()>().instrument(tool).await;
            }
            .instrument(root);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(1), future)
                    .await
                    .is_err()
            );
        }
        .with_subscriber(subscriber)
        .await;
        let spans = exporter.get_finished_spans().unwrap();
        assert_eq!(spans.len(), 2);
        assert!(
            spans
                .iter()
                .all(|s| attribute(s, "langfuse.observation.metadata.status").as_deref() == Some("interrupted"))
        );
        let root = spans.iter().find(|s| s.name == "turn").unwrap();
        let tool = spans.iter().find(|s| s.name == "slow tool").unwrap();
        assert_eq!(tool.parent_span_id, root.span_context.span_id());
    }
}

#[cfg(test)]
mod resume_tests {
    use super::{
        tests::{attribute, exporter},
        *,
    };
    use tracing::{Instrument, instrument::WithSubscriber};

    #[tokio::test]
    async fn workflow_resume_restores_durable_parent_before_identity_starts_the_span() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE run_records(id TEXT PRIMARY KEY, runtime_json TEXT); INSERT INTO run_records VALUES('run','{}')").execute(&pool).await.unwrap();
        let (subscriber, exporter, _provider) = exporter();
        fn phase() -> Span {
            tracing::info_span!("workrun.workflow.run", "otel.name" = "resume fixture")
        }
        async {
            crate::core::telemetry_langfuse::user(
                crate::core::telemetry_langfuse::User::personal(Some("Fixture user")),
                async {
                    let first = phase();
                    crate::core::telemetry::workflow_parent(&pool, "run", &serde_json::json!({}), &first).await;
                    drop(first);
                    let runtime: String = sqlx::query_scalar("SELECT runtime_json FROM run_records WHERE id='run'")
                        .fetch_one(&pool)
                        .await
                        .unwrap();
                    let second = phase();
                    crate::core::telemetry::workflow_parent(
                        &pool,
                        "run",
                        &serde_json::from_str(&runtime).unwrap(),
                        &second,
                    )
                    .await;
                    async {
                        drop(tracing::info_span!("resumed.node"));
                    }
                    .instrument(second)
                    .await;
                },
            )
            .await;
        }
        .with_subscriber(subscriber)
        .await;
        let spans = exporter.get_finished_spans().unwrap();
        let phases = spans.iter().filter(|s| s.name == "resume fixture").collect::<Vec<_>>();
        assert_eq!(phases.len(), 2);
        assert_eq!(phases[1].parent_span_id, phases[0].span_context.span_id());
        assert!(
            spans
                .iter()
                .all(|s| s.span_context.trace_id() == phases[0].span_context.trace_id())
        );
        assert!(
            phases
                .iter()
                .all(|s| attribute(s, "langfuse.trace.metadata.userName").as_deref() == Some("Fixture user"))
        );
    }
}
