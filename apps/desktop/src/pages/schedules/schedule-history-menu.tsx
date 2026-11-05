import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@workspace/ui/components';
import { HistoryIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SchedulingSessionSummary } from '@/services/schedules';

export function ScheduleHistoryMenu({
  conversations,
  selectedId,
  loading,
  error,
  deleting,
  onSelect,
  onDelete,
  onNew,
}: {
  conversations: SchedulingSessionSummary[];
  selectedId: string;
  loading: boolean;
  error?: string;
  deleting: boolean;
  onSelect: (conversation: SchedulingSessionSummary) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className='flex items-center gap-2'>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant='ghost' size='icon-sm' />}
          title={t('schedules.conversations')}
          aria-label={t('schedules.conversations')}
        >
          <HistoryIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          className='max-h-[min(24rem,var(--available-height))] w-72 max-w-[calc(100vw-2rem)]'
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              {t('schedules.conversations')}
            </DropdownMenuLabel>
            {(loading || error || !conversations.length) && (
              <DropdownMenuItem disabled>
                {error ||
                  t(
                    loading ? 'schedules.loading' : 'schedules.noConversations',
                  )}
              </DropdownMenuItem>
            )}
            <DropdownMenuRadioGroup value={selectedId}>
              {conversations.map((c) => (
                <div
                  key={c.id}
                  className='group/history data-[selected=true]:bg-muted flex min-w-0 items-center gap-1 rounded-md'
                  data-selected={c.id === selectedId}
                >
                  <DropdownMenuRadioItem
                    value={c.id}
                    closeOnClick
                    onClick={() => onSelect(c)}
                    className='min-w-0 flex-1 py-2'
                  >
                    <span className='truncate' title={c.title}>
                      {c.title || t('start.newTask')}
                    </span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuItem
                    variant='destructive'
                    closeOnClick={false}
                    className='shrink-0 opacity-0 group-focus-within/history:opacity-100 group-hover/history:opacity-100 group-data-[selected=true]/history:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100'
                    aria-label={`${t('schedules.deleteConversation')}: ${c.title || t('start.newTask')}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      // Disabling every item reveals hidden icons through the menu's
                      // disabled opacity style. Keep their appearance stable while locked.
                      if (!deleting) onDelete(c.id);
                    }}
                  >
                    <Trash2Icon />
                  </DropdownMenuItem>
                </div>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant='default'
        size='sm'
        onClick={onNew}
        aria-label={t('schedules.new')}
      >
        <PlusIcon data-icon='inline-start' />
        <span className='hidden sm:inline'>{t('schedules.toolbarNew')}</span>
      </Button>
    </div>
  );
}
