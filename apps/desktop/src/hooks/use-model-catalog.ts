import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getModelCatalogStatus } from '@/services/cmd';
import { useWorkrunStore } from '@/stores';

export function useModelCatalog(enabled = true) {
  const mode = useWorkrunStore((state) => state.config?.workspace_mode);
  const server = useWorkrunStore((state) => state.config?.team?.server_url);
  const userId = useWorkrunStore((state) => state.teamUser?.id);
  const queryClient = useQueryClient();
  const queryKey = [
    'modelCatalog',
    mode ?? 'personal',
    mode === 'team' ? server : '',
    mode === 'team' ? userId : '',
  ];
  const query = useQuery({
    // Never show another Server/account's cached directory during a transition.
    queryKey,
    queryFn: () => getModelCatalogStatus(),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  return {
    ...query,
    data: query.data?.models,
    serverError: query.data?.serverError,
    refresh: () =>
      queryClient.fetchQuery({
        queryKey,
        queryFn: () => getModelCatalogStatus(true),
        staleTime: 0,
      }),
  };
}
