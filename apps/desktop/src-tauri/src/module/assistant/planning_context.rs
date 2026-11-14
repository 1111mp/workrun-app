//! Labels existing conversation messages without loading or replaying history.
use adk_rust::Content;
use serde_json::{Value, json};

pub(super) fn conversation(history: &[Content], supplied: &[Content]) -> Vec<Value> {
    history
        .iter()
        .enumerate()
        .filter(|(_, message)| matches!(message.role.as_str(), "user" | "model"))
        .map(|(index, message)| {
            let mut entry = json!({
                "message_index":index,"role":message.role,
                "source":if message.role=="user" {"user_expression"}else{"assistant_generated_unverified"},
                "text":super::model::content_text(message)
            });
            // The SDK already supplies the current user message. Keep its native
            // index/source label, but never repeat a large body inside JSON too.
            if index + 1 == history.len()
                && message.role == "user"
                && supplied.iter().any(|content| {
                    content.role == "user" && super::model::content_text(content) == super::model::content_text(message)
                })
            {
                entry.as_object_mut().unwrap().remove("text");
                entry["text_source"] = json!("current_user_message");
            }
            entry
        })
        .collect()
}

/// Index binding sources without duplicating potentially large user messages.
/// Full text remains in original history; previews are only navigation aids.
pub(super) fn input_sources(history: &[Content]) -> Vec<Value> {
    history
        .iter()
        .enumerate()
        .filter(|(_, message)| message.role == "user")
        .enumerate()
        .map(|(ordinal, (index, message))| {
            let text = super::model::content_text(message);
            json!({"message":index,"userOrdinal":ordinal,
                "preview":text.chars().take(80).collect::<String>(),
                "previewTruncated":text.chars().count()>80})
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn planning_context_labels_model_prose_without_promoting_it_to_user_facts() {
        let history = [
            Content::new("user").with_text("Prepare a summary"),
            Content::new("model").with_text("The file must describe monthly orders"),
            Content::new("function").with_text("not conversational prose"),
        ];
        let context = conversation(&history, &[]);
        assert_eq!(context.len(), 2);
        assert_eq!(context[0]["source"], "user_expression");
        assert_eq!(context[1]["source"], "assistant_generated_unverified");
        assert_eq!(context[1]["message_index"], 1);
    }
    #[test]
    fn latest_body_is_supplied_once_without_losing_prior_context_or_indices() {
        let text = "本次用户输入".repeat(5000);
        let history = vec![
            Content::new("user").with_text("Earlier scope"),
            Content::new("model").with_text("Unverified assumption"),
            Content::new("user").with_text(&text),
        ];
        let supplied = vec![history[2].clone()];
        let compact = conversation(&history, &supplied);
        assert_eq!(compact[0]["text"], "Earlier scope");
        assert_eq!(compact[1]["source"], "assistant_generated_unverified");
        assert_eq!(compact[2]["message_index"], 2);
        assert_eq!(compact[2]["source"], "user_expression");
        assert!(compact[2].get("text").is_none());
        assert_eq!(compact[2]["text_source"], "current_user_message");
        assert_eq!(super::super::model::content_text(&supplied[0]), text);
        // If the SDK did not supply the original, retain it in labeled history.
        assert_eq!(conversation(&history, &[])[2]["text"], text);
        assert_eq!(
            conversation(&history, &[Content::new("user").with_text("different")])[2]["text"],
            text
        );
    }

    #[test]
    fn binding_index_preserves_original_positions_without_repeating_large_bodies() {
        let source = format!("{} amount=1700", "数据".repeat(10000));
        let history = vec![
            Content::new("user").with_text(&source),
            Content::new("model").with_text("reply"),
            Content::new("function").with_text("receipt"),
            Content::new("user").with_text("执行数量 17"),
        ];
        let original = serde_json::to_value(&history).unwrap();
        let index = input_sources(&history);
        assert_eq!(index[0]["message"], 0);
        assert_eq!(index[1]["message"], 3);
        assert_eq!(index[1]["userOrdinal"], 1);
        assert_eq!(index[0]["preview"].as_str().unwrap().chars().count(), 80);
        assert_eq!(index[0]["previewTruncated"], true);
        assert_eq!(index[1]["previewTruncated"], false);
        assert!(serde_json::to_string(&index).unwrap().len() < 1000);
        assert_eq!(serde_json::to_value(&history).unwrap(), original);
        assert_eq!(super::super::model::content_text(&history[0]), source);
        assert!(!index[0]["preview"].as_str().unwrap().contains("1700"));
        let schema = json!({"type":"object","properties":{"amount":{"type":"integer"}},"required":["amount"]});
        let binding =
            json!([{"input":"amount","source":"message","message":0,"quote":"amount=1700","value_json":"1700"}]);
        assert_eq!(
            super::super::bindings::resolve(&schema, &binding, &history).unwrap(),
            json!({"amount":1700})
        );
    }
}
