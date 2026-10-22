//! One bounded, best-effort writer. Model execution never waits for this queue.
use super::persist;
use serde_json::Value;
use sqlx::SqlitePool;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

static WRITER: OnceLock<Writer> = OnceLock::new();
static UNAVAILABLE: AtomicBool = AtomicBool::new(false);
const CAPACITY: usize = 256;
const WRITE_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub(super) struct Writer {
    sender: mpsc::Sender<Message>,
    degraded: Arc<AtomicBool>,
}

enum Message {
    Record(Value),
    Flush(oneshot::Sender<()>),
}

impl Writer {
    pub(super) fn new(pool: SqlitePool) -> Self {
        let (sender, mut receiver) = mpsc::channel(CAPACITY);
        let degraded = Arc::new(AtomicBool::new(false));
        let failures = degraded.clone();
        tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                match message {
                    Message::Record(record) => {
                        // Retry once in this same worker, preserving queue order.
                        let mut saved = false;
                        for _ in 0..2 {
                            if matches!(
                                tokio::time::timeout(WRITE_TIMEOUT, persist(&pool, &record)).await,
                                Ok(Ok(()))
                            ) {
                                saved = true;
                                break;
                            }
                        }
                        if !saved {
                            failures.store(true, Ordering::Relaxed);
                            log::warn!("Model usage write failed; recorded totals may be incomplete");
                        }
                    },
                    Message::Flush(done) => {
                        let _ = done.send(());
                    },
                }
            }
        });
        Self { sender, degraded }
    }

    pub(super) fn record(&self, record: Value) {
        if self.sender.try_send(Message::Record(record)).is_err() {
            self.degraded.store(true, Ordering::Relaxed);
            log::warn!("Model usage queue unavailable; recorded totals may be incomplete");
        }
    }

    pub(super) fn degraded(&self) -> bool {
        self.degraded.load(Ordering::Relaxed)
    }

    pub(super) async fn flush(&self, timeout: Duration) -> bool {
        let (send, receive) = oneshot::channel();
        matches!(
            tokio::time::timeout(timeout, async {
                self.sender.send(Message::Flush(send)).await.ok()?;
                receive.await.ok()
            })
            .await,
            Ok(Some(()))
        )
    }
}

pub(super) fn shared() -> Option<Writer> {
    match crate::core::db::DBManager::global().pool() {
        Ok(pool) => Some(WRITER.get_or_init(|| Writer::new(pool)).clone()),
        Err(_) => {
            UNAVAILABLE.store(true, Ordering::Relaxed);
            None
        },
    }
}

// This warning is process-wide, not a claim about how many tokens a session lost.
pub(super) fn degraded() -> bool {
    UNAVAILABLE.load(Ordering::Relaxed) || WRITER.get().is_some_and(Writer::degraded)
}

pub async fn flush() {
    if let Some(writer) = WRITER.get()
        && !writer.flush(Duration::from_secs(1)).await
    {
        UNAVAILABLE.store(true, Ordering::Relaxed);
        log::warn!("Model usage flush timed out during shutdown");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn saturated_queue_drops_records_and_flush_is_bounded() {
        // An intentionally unpolled receiver makes saturation deterministic.
        let (sender, _receiver) = mpsc::channel(1);
        let writer = Writer {
            sender,
            degraded: Arc::new(AtomicBool::new(false)),
        };
        writer.record(serde_json::json!({"id":"first"}));
        writer.record(serde_json::json!({"id":"dropped"}));
        assert!(writer.degraded());
        assert!(!writer.flush(Duration::from_millis(10)).await);
    }
}
