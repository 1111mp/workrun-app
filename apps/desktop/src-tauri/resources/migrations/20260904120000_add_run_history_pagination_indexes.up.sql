CREATE INDEX idx_run_records_started_at_id
  ON run_records(started_at DESC, id DESC);

CREATE INDEX idx_run_records_target_started_at_id
  ON run_records(target_type, target_id, started_at DESC, id DESC);

CREATE INDEX idx_run_records_status_started_at_id
  ON run_records(status, started_at DESC, id DESC);
