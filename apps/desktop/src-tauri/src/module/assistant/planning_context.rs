//! Labels existing conversation messages without loading or replaying history.
use adk_rust::Content;
use serde_json::{Value, json};

pub(super) fn conversation(history: &[Content]) -> Vec<Value> {
    history
        .iter()
        .enumerate()
        .filter(|(_, message)| matches!(message.role.as_str(), "user" | "model"))
        .map(|(index, message)| {
            json!({
                "message_index":index,"role":message.role,
                "source":if message.role=="user" {"user_expression"}else{"assistant_generated_unverified"},
                "text":super::model::content_text(message)
            })
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
        let context = conversation(&history);
        assert_eq!(context.len(), 2);
        assert_eq!(context[0]["source"], "user_expression");
        assert_eq!(context[1]["source"], "assistant_generated_unverified");
        assert_eq!(context[1]["message_index"], 1);
    }
}
