import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { inspectRunRecord } from '@/services/run-history';

export function useWorkflowRunRecord(
  runId: string | undefined,
  revision: number,
  enabled: boolean,
) {
  const client = useQueryClient();
  const previous = useRef({ runId, revision });
  const query = useQuery({
    queryKey: ['run-history-inspect', runId],
    queryFn: () => inspectRunRecord(runId!),
    enabled: Boolean(runId) && enabled,
  });

  useEffect(() => {
    const changed =
      previous.current.runId === runId &&
      previous.current.revision !== revision;
    previous.current = { runId, revision };
    // A revision refreshes the same record; it is not a new cache identity.
    // Real cached data survives both slow refetches and refetch errors, unlike
    // placeholder data on a fresh revision key.
    if (runId && enabled && changed)
      void client.invalidateQueries({
        queryKey: ['run-history-inspect', runId],
        exact: true,
      });
  }, [client, runId, revision, enabled]);

  return query;
}
