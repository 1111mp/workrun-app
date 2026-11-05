import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  InputGroupButton,
} from '@workspace/ui/components';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function AssistantModelSelector({
  models,
  modelId,
  effort,
  onModelChange,
  onEffortChange,
  disabled,
}: {
  models: ModelDefinition[];
  modelId: string;
  effort?: ReasoningEffort;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort?: ReasoningEffort) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const selected = models.find((model) => model.id === modelId);
  const providers = [...new Set(models.map((model) => model.provider))];
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          render={
            <InputGroupButton size='sm' className='max-w-40 sm:max-w-64' />
          }
          aria-label={t('assistant.model')}
        >
          <span className='truncate'>
            {selected?.name ?? t('assistant.selectModel')}
          </span>
          <ChevronDownIcon data-icon='inline-end' />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side='bottom'
          align='end'
          className='max-h-[min(24rem,var(--available-height))] w-max max-w-[min(22rem,calc(100vw-2rem))] min-w-(--anchor-width)'
        >
          <DropdownMenuRadioGroup value={modelId} onValueChange={onModelChange}>
            {providers.map((provider) => (
              <DropdownMenuGroup key={provider}>
                <DropdownMenuLabel>{provider}</DropdownMenuLabel>
                {models
                  .filter((model) => model.provider === provider)
                  .map((model) => (
                    <DropdownMenuRadioItem
                      key={model.id}
                      value={model.id}
                      closeOnClick
                    >
                      <span className='min-w-0 wrap-anywhere whitespace-normal'>
                        {model.name}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {Boolean(selected?.effortOptions?.length) && (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
            render={<InputGroupButton size='sm' />}
            aria-label='Effort'
          >
            {effort ? effort[0].toUpperCase() + effort.slice(1) : 'Default'}
            <ChevronDownIcon data-icon='inline-end' />
          </DropdownMenuTrigger>
          <DropdownMenuContent side='bottom' align='end'>
            <DropdownMenuRadioGroup
              value={effort ?? 'default'}
              onValueChange={(value) =>
                onEffortChange(
                  value === 'default' ? undefined : (value as ReasoningEffort),
                )
              }
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel>Effort</DropdownMenuLabel>
                {['default', ...selected!.effortOptions!].map((value) => (
                  <DropdownMenuRadioItem key={value} value={value} closeOnClick>
                    {value[0].toUpperCase() + value.slice(1)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
