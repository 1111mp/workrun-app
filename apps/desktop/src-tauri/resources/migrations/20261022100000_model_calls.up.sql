-- Calls are independent of session lifetimes; deleting a conversation must not
-- silently change the usage ledger. No prompts or file contents are stored.
CREATE TABLE
  model_calls (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    session_kind TEXT,
    session_id TEXT,
    run_id TEXT,
    started_at TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL
  );

CREATE INDEX model_calls_session ON model_calls (
  workspace_id,
  session_kind,
  session_id,
  started_at
);

CREATE INDEX model_calls_run ON model_calls (workspace_id, run_id);

-- Import only actual model spans. Keep unknown usage null and preserve the
-- original span ID so importing history can never create an extra call.
INSERT INTO
  model_calls
SELECT
  s.id,
  r.workspace_id,
  CASE
    WHEN json_extract (r.runtime_json, '$.chatSessionId') IS NOT NULL THEN 'workflow_chat'
  END,
  json_extract (r.runtime_json, '$.chatSessionId'),
  r.id,
  s.started_at,
  s.status,
  json_object (
    'id',
    s.id,
    'context',
    json_object (
      'workspaceId',
      r.workspace_id,
      'sessionKind',
      CASE
        WHEN json_extract (r.runtime_json, '$.chatSessionId') IS NOT NULL THEN 'workflow_chat'
      END,
      'sessionId',
      json_extract (r.runtime_json, '$.chatSessionId'),
      'runId',
      r.id,
      'nodeId',
      s.node_id,
      'purpose',
      'workflow',
      'provider',
      s.provider
    ),
    'model',
    s.model,
    'startedAt',
    s.started_at,
    'endedAt',
    s.ended_at,
    'status',
    s.status,
    'durationMs',
    s.duration_ms,
    'source',
    'legacy_run_span',
    'usage',
    CASE
      WHEN s.total_tokens IS NOT NULL
      OR s.input_tokens IS NOT NULL
      OR s.output_tokens IS NOT NULL THEN json_object (
        'inputTokens',
        s.input_tokens,
        'outputTokens',
        s.output_tokens,
        'totalTokens',
        COALESCE(
          s.total_tokens,
          COALESCE(s.input_tokens, 0) + COALESCE(s.output_tokens, 0)
        ),
        'totalTokensEstimated',
        json (
          CASE
            WHEN s.total_tokens_estimated = 1
            OR s.total_tokens IS NULL THEN 'true'
            ELSE 'false'
          END
        ),
        'cacheReadTokens',
        s.cache_read_tokens,
        'cacheWriteTokens',
        s.cache_write_tokens,
        'reasoningTokens',
        s.reasoning_tokens
      )
    END
  )
FROM
  run_spans s
  JOIN run_records r ON r.id = s.run_id
WHERE
  s.kind = 'model_call';