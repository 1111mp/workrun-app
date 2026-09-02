use adk_rust::{
    graph::{State, StreamEvent},
    guardrail::{
        ContentFilter, Guardrail, GuardrailResult, GuardrailSet, PiiRedactor, PiiType, Severity, ToolGuardrail,
        ToolGuardrailResult, ToolGuardrailSet,
    },
    prelude::{Content, Part},
};
use regex::Regex;
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    sync::LazyLock,
};

const SECRET_REDACTION: &str = "[SECRET_REDACTED]";
const SENSITIVE_FIELD_REDACTION: &str = "[SENSITIVE REDACTED]";
const CHINA_PHONE_REDACTION: &str = "[PHONE REDACTED]";
const CHINA_ID_REDACTION: &str = "[CHINA ID REDACTED]";

static PII_REDACTOR: LazyLock<PiiRedactor> = LazyLock::new(|| {
    PiiRedactor::with_types(&[
        PiiType::Email,
        PiiType::Phone,
        PiiType::Ssn,
        PiiType::CreditCard,
        PiiType::IpAddress,
    ])
});
static CHINA_ID_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[1-9]\d{5}(?:(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]|\d{6}[0-9Xx]{3})")
        .expect("China ID pattern is valid")
});
static CHINA_PHONE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:\+?86[-\s]?)?1[3-9]\d{9}").expect("China phone pattern is valid"));
static SECRET_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}",
        r"\bsk-[A-Za-z0-9_-]{16,}\b",
        r"\bgh[pousr]_[A-Za-z0-9]{20,}\b",
        r"\bAKIA[0-9A-Z]{16}\b",
        r"(?s)-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----.*?-----END(?: [A-Z]+)? PRIVATE KEY-----",
    ]
    .into_iter()
    .map(|pattern| Regex::new(pattern).expect("secret pattern is valid"))
    .collect()
});
static SECRET_ASSIGNMENT_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?P<label>["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\n,}\]]+)"#,
    )
    .expect("secret assignment pattern is valid")
});

pub(super) fn input_guardrails() -> GuardrailSet {
    GuardrailSet::new()
        .with(ContentFilter::max_length(50_000))
        .with(PiiRedactor::with_types(&[
            PiiType::Email,
            PiiType::Phone,
            PiiType::Ssn,
            PiiType::CreditCard,
            PiiType::IpAddress,
        ]))
        .with(ChinaPiiRedactor)
        .with(SecretBlocker)
}

pub(super) fn output_guardrails() -> GuardrailSet {
    GuardrailSet::new()
        .with(PiiRedactor::with_types(&[
            PiiType::Email,
            PiiType::Phone,
            PiiType::Ssn,
            PiiType::CreditCard,
            PiiType::IpAddress,
        ]))
        .with(ChinaPiiRedactor)
        .with(SecretRedactor)
}

pub(super) fn tool_guardrails() -> ToolGuardrailSet {
    ToolGuardrailSet::new().with(SecretToolGuardrail)
}

pub(super) fn ensure_tool_args_safe(args: &Value) -> adk_rust::Result<()> {
    if contains_secret_json(args) {
        return Err(adk_rust::AdkError::tool(
            "Tool arguments contain credentials or authentication secrets",
        ));
    }
    Ok(())
}

pub(super) fn ensure_tool_args_resolved(args: &Value) -> adk_rust::Result<()> {
    if let Some(path) = redacted_argument_path(args, "") {
        return Err(adk_rust::AdkError::tool(format!(
            "Tool argument `{path}` is still redacted; grant raw State access or configure a State Binding"
        )));
    }
    Ok(())
}

pub(super) fn redact_text(text: &str) -> String {
    let (text, _) = PII_REDACTOR.redact(text);
    let text = redact_china_pii(&text);
    redact_secrets(&text)
}

pub(super) fn redact_json(value: &Value) -> Value {
    let mut value = value.clone();
    redact_json_in_place(&mut value);
    value
}

/// Produces one visible node-output value. Explicit paths supplement the
/// automatic PII and secret detection because some sensitive business data is
/// not recognizable from its name or contents.
pub(super) fn visible_node_state_value(value: &Value, key: &str, sensitive_fields: &BTreeSet<String>) -> Value {
    let mut visible = redact_json(value);
    for path in sensitive_fields {
        let path = if path == key {
            ""
        } else if let Some(path) = path.strip_prefix(key).and_then(|path| path.strip_prefix('.')) {
            path
        } else {
            continue;
        };
        if path.is_empty() {
            if !visible.is_null() {
                visible = Value::String(SENSITIVE_FIELD_REDACTION.to_string());
            }
        } else {
            redact_value_at_path(&mut visible, path);
        }
    }
    visible
}

pub(super) fn visible_input_state(value: &Value, sensitive_fields: &BTreeSet<String>) -> Value {
    let mut visible = redact_json(value);
    if let Some(fields) = visible.as_object_mut() {
        for key in sensitive_fields {
            if fields.get(key).is_some_and(|value| !value.is_null()) {
                fields.insert(key.clone(), Value::String(SENSITIVE_FIELD_REDACTION.to_string()));
            }
        }
    }
    visible
}

pub(crate) fn redact_state(state: &State) -> State {
    state
        .iter()
        .map(|(key, value)| (key.clone(), redact_json(value)))
        .collect()
}

pub(crate) fn redact_stream_event(event: StreamEvent) -> StreamEvent {
    match event {
        StreamEvent::State { state, step } => StreamEvent::State {
            state: redact_state(&state),
            step,
        },
        StreamEvent::Updates { node, updates } => StreamEvent::Updates {
            node,
            updates: redact_updates(updates),
        },
        StreamEvent::Message {
            node,
            content,
            is_final,
        } => StreamEvent::Message {
            node,
            content: redact_text(&content),
            is_final,
        },
        StreamEvent::Custom { node, event_type, data } => StreamEvent::Custom {
            node,
            event_type,
            data: redact_json(&data),
        },
        StreamEvent::Debug { event_type, data } => StreamEvent::Debug {
            event_type,
            data: redact_json(&data),
        },
        StreamEvent::Interrupted { node, message } => StreamEvent::Interrupted {
            node,
            message: redact_text(&message),
        },
        StreamEvent::NodeInterrupt { node, message, data } => StreamEvent::NodeInterrupt {
            node,
            message: redact_text(&message),
            data: data.map(|value| redact_json(&value)),
        },
        StreamEvent::Done { state, total_steps } => StreamEvent::Done {
            state: redact_state(&state),
            total_steps,
        },
        StreamEvent::Error { message, node } => StreamEvent::Error {
            message: redact_text(&message),
            node,
        },
        event => event,
    }
}

fn redact_updates(updates: HashMap<String, Value>) -> HashMap<String, Value> {
    updates
        .into_iter()
        .map(|(key, value)| (key, redact_json(&value)))
        .collect()
}

fn redact_json_in_place(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if is_sensitive_key(key) && !value.is_null() {
                    *value = Value::String(SECRET_REDACTION.to_string());
                } else {
                    redact_json_in_place(value);
                }
            }
        },
        Value::Array(values) => values.iter_mut().for_each(redact_json_in_place),
        Value::String(text) => *text = redact_text(text),
        _ => {},
    }
}

fn redact_value_at_path(value: &mut Value, path: &str) {
    let mut segments = path.split('.').peekable();
    let mut current = value;
    while let Some(segment) = segments.next() {
        let Value::Object(object) = current else {
            return;
        };
        let Some(next) = object.get_mut(segment) else {
            return;
        };
        if segments.peek().is_none() {
            if !next.is_null() {
                *next = Value::String(SENSITIVE_FIELD_REDACTION.to_string());
            }
            return;
        }
        current = next;
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "authorization"
            | "cookie"
            | "password"
            | "passwd"
            | "secret"
            | "privatekey"
    )
}

fn contains_secret_json(value: &Value) -> bool {
    match value {
        Value::Object(object) => object
            .iter()
            .any(|(key, value)| (is_sensitive_key(key) && !value.is_null()) || contains_secret_json(value)),
        Value::Array(values) => values.iter().any(contains_secret_json),
        Value::String(text) => contains_secret(text),
        _ => false,
    }
}

fn redacted_argument_path(value: &Value, path: &str) -> Option<String> {
    match value {
        Value::Object(object) => object.iter().find_map(|(key, value)| {
            let path = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            redacted_argument_path(value, &path)
        }),
        Value::Array(values) => values
            .iter()
            .enumerate()
            .find_map(|(index, value)| redacted_argument_path(value, &format!("{path}[{index}]"))),
        Value::String(text) if is_redaction_marker(text) => Some(path.to_string()),
        _ => None,
    }
}

fn is_redaction_marker(value: &str) -> bool {
    value.starts_with('[') && value.ends_with(']') && value.contains("REDACTED")
}

fn contains_secret(text: &str) -> bool {
    SECRET_ASSIGNMENT_PATTERN.is_match(text) || SECRET_PATTERNS.iter().any(|pattern| pattern.is_match(text))
}

fn redact_secrets(text: &str) -> String {
    let text = SECRET_PATTERNS.iter().fold(text.to_string(), |text, pattern| {
        pattern.replace_all(&text, SECRET_REDACTION).into_owned()
    });
    SECRET_ASSIGNMENT_PATTERN
        .replace_all(&text, format!(r#"${{label}}"{SECRET_REDACTION}""#))
        .into_owned()
}

fn redact_china_pii(text: &str) -> String {
    let text = CHINA_ID_PATTERN.replace_all(text, CHINA_ID_REDACTION).into_owned();
    CHINA_PHONE_PATTERN
        .replace_all(&text, CHINA_PHONE_REDACTION)
        .into_owned()
}

fn transform_content(content: &Content, transform: impl Fn(&str) -> String, reason: &str) -> GuardrailResult {
    let mut transformed = false;
    let parts = content
        .parts
        .iter()
        .map(|part| match part {
            Part::Text { text } => {
                let replacement = transform(text);
                transformed |= replacement != *text;
                Part::Text { text: replacement }
            },
            _ => part.clone(),
        })
        .collect();

    if transformed {
        GuardrailResult::Transform {
            new_content: Content {
                role: content.role.clone(),
                parts,
            },
            reason: reason.to_string(),
        }
    } else {
        GuardrailResult::Pass
    }
}

struct ChinaPiiRedactor;

#[async_trait::async_trait]
impl Guardrail for ChinaPiiRedactor {
    fn name(&self) -> &str {
        "workrun_china_pii_redactor"
    }

    async fn validate(&self, content: &Content) -> GuardrailResult {
        transform_content(content, redact_china_pii, "Redacted Chinese PII")
    }

    fn run_parallel(&self) -> bool {
        false
    }
}

struct SecretRedactor;

#[async_trait::async_trait]
impl Guardrail for SecretRedactor {
    fn name(&self) -> &str {
        "workrun_secret_redactor"
    }

    async fn validate(&self, content: &Content) -> GuardrailResult {
        transform_content(content, redact_secrets, "Redacted credentials")
    }

    fn run_parallel(&self) -> bool {
        false
    }
}

struct SecretBlocker;

#[async_trait::async_trait]
impl Guardrail for SecretBlocker {
    fn name(&self) -> &str {
        "workrun_secret_blocker"
    }

    async fn validate(&self, content: &Content) -> GuardrailResult {
        if content.parts.iter().filter_map(Part::text).any(contains_secret) {
            GuardrailResult::Fail {
                reason: "Input contains credentials or authentication secrets".to_string(),
                severity: Severity::High,
            }
        } else {
            GuardrailResult::Pass
        }
    }
}

struct SecretToolGuardrail;

#[async_trait::async_trait]
impl ToolGuardrail for SecretToolGuardrail {
    fn name(&self) -> &str {
        "workrun_secret_tool_guardrail"
    }

    async fn validate_call(&self, _tool_name: &str, args: &Value) -> ToolGuardrailResult {
        if contains_secret_json(args) {
            ToolGuardrailResult::deny(
                "Tool arguments contain credentials or authentication secrets",
                Severity::High,
            )
        } else {
            ToolGuardrailResult::Allow
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adk_rust::guardrail::{GuardrailExecutor, ToolCallDecision};
    use serde_json::json;

    fn content_text(content: &Content) -> String {
        content.parts.iter().filter_map(Part::text).collect()
    }

    #[test]
    fn redacts_supported_pii_and_credentials() {
        let input = concat!(
            "email alice@example.com; phone 555-123-4567; China phone 13800138000; ",
            "ID 11010519491231002X; IP 192.168.1.10; Bearer abcdefghijklmnop"
        );

        let redacted = redact_text(input);

        assert!(!redacted.contains("alice@example.com"));
        assert!(!redacted.contains("555-123-4567"));
        assert!(!redacted.contains("13800138000"));
        assert!(!redacted.contains("11010519491231002X"));
        assert!(!redacted.contains("192.168.1.10"));
        assert!(!redacted.contains("abcdefghijklmnop"));
        assert!(redacted.contains(SECRET_REDACTION));
    }

    #[test]
    fn recursively_redacts_json_and_sensitive_fields() {
        let input = json!({
            "email": "alice@example.com",
            "nested": [{"apiKey": "sk-abcdefghijklmnopqrst"}],
            "password": 123456,
        });

        assert_eq!(
            redact_json(&input),
            json!({
                "email": "[EMAIL REDACTED]",
                "nested": [{"apiKey": SECRET_REDACTION}],
                "password": SECRET_REDACTION,
            })
        );
    }

    #[test]
    fn keeps_text_json_valid_when_redacting_secret_values() {
        let redacted = redact_text(r#"{"apiKey":"sk-abcdefghijklmnopqrst","name":"Alice"}"#);
        let value: Value = serde_json::from_str(&redacted).unwrap();

        assert_eq!(value["apiKey"], SECRET_REDACTION);
        assert_eq!(value["name"], "Alice");
    }

    #[tokio::test]
    async fn input_guardrails_redact_pii_and_block_secrets() {
        let pii = Content::new("user").with_text("联系 13800138000 或 alice@example.com");
        let result = GuardrailExecutor::run(&input_guardrails(), &pii).await.unwrap();
        let transformed = result.transformed_content.unwrap();
        let transformed = content_text(&transformed);
        assert!(result.passed);
        assert_eq!(transformed, "联系 [PHONE REDACTED] 或 [EMAIL REDACTED]");

        let secret = Content::new("user").with_text("Authorization: Bearer abcdefghijklmnop");
        let result = GuardrailExecutor::run(&input_guardrails(), &secret).await.unwrap();
        assert!(!result.passed);
        assert_eq!(result.failures[0].0, "workrun_secret_blocker");
        assert!(!result.failures[0].1.contains("abcdefghijklmnop"));
    }

    #[tokio::test]
    async fn tool_guardrails_deny_secret_arguments() {
        let decision = tool_guardrails()
            .evaluate("send_request", &json!({"authorization": "Bearer abcdefghijklmnop"}))
            .await;

        assert!(matches!(decision, ToolCallDecision::Deny { .. }));
    }

    #[test]
    fn blocks_tool_arguments_with_nested_redaction_markers() {
        let error = ensure_tool_args_resolved(&json!({
            "recipient": {"email": "[EMAIL REDACTED]"}
        }))
        .unwrap_err();

        assert!(error.to_string().contains("recipient.email"));
        assert!(ensure_tool_args_resolved(&json!({"recipient": "alice@example.com"})).is_ok());
    }

    #[test]
    fn redacts_all_payload_bearing_stream_events() {
        let event = StreamEvent::custom(
            "agent",
            "agent.tool_result",
            json!({"input": {"email": "alice@example.com"}}),
        );

        let StreamEvent::Custom { data, .. } = redact_stream_event(event) else {
            panic!("expected custom event")
        };
        assert_eq!(data["input"]["email"], "[EMAIL REDACTED]");
    }
}
