import { useQuery } from '@tanstack/react-query';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@workspace/ui/components';
import { ChevronRightIcon } from 'lucide-react';
import { Controller, type UseFormReturn, FieldArray } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { getModelCatalog } from '@/services/cmd';

import type { SettingsForm } from './settings-schema';

const PROVIDER_SETTING_KEY = {
  gemini: 'gemini',
  open_ai: 'openAi',
  open_ai_strict: 'openAi',
  anthropic: 'anthropic',
  deep_seek: 'deepSeek',
  groq: 'groq',
  ollama: 'ollama',
} as const satisfies Record<ModelProvider, string>;

const NO_SUMMARY_MODEL = '__none__';

const MODEL_PROVIDER_LABEL: Record<ModelProvider, string> = {
  gemini: 'Gemini',
  open_ai: 'OpenAI',
  open_ai_strict: 'OpenAI Strict',
  anthropic: 'Anthropic',
  deep_seek: 'DeepSeek',
  groq: 'Groq',
  ollama: 'Ollama',
};

function ModelProfilesSettings({
  form,
}: {
  form: UseFormReturn<SettingsForm>;
}) {
  const { t } = useTranslation();
  const { data: modelProfiles = [] } = useQuery({
    queryKey: ['modelCatalog'],
    queryFn: getModelCatalog,
  });

  return (
    <FieldSet className='gap-1'>
      <FieldLegend className='text-muted-foreground'>
        {t('settings.models.title')}
      </FieldLegend>
      <FieldDescription>{t('settings.models.description')}</FieldDescription>
      <div className='overflow-hidden rounded-xl'>
        <FieldGroup className='gap-0'>
          <FieldArray
            control={form.control}
            name='provider_credentials'
            render={({ fields }) => (
              <>
                {fields.map((field, index) => (
                  <Field key={field.id}>
                    <FieldLabel
                      htmlFor={
                        field.provider === 'ollama'
                          ? `model-base-url-${field.provider}`
                          : `model-api-key-${field.provider}`
                      }
                    >
                      <Item
                        variant='muted'
                        size='sm'
                        className='hover:bg-muted rounded-none py-1.5'
                      >
                        <ItemContent>
                          <ItemTitle>
                            {t(
                              `settings.models.${PROVIDER_SETTING_KEY[field.provider]}`,
                            )}
                          </ItemTitle>
                          {/* <ItemDescription>{description}</ItemDescription> */}
                        </ItemContent>
                        <ItemActions>
                          <div className='flex w-80 flex-col gap-1 sm:flex-row'>
                            {field.provider !== 'ollama' && (
                              <Input
                                id={`model-api-key-${field.provider}`}
                                type='password'
                                autoComplete='off'
                                placeholder={t(
                                  'settings.models.apiKeyPlaceholder',
                                )}
                                className='text-muted-foreground border-none bg-transparent! pr-0 text-right outline-none focus-visible:border-none focus-visible:ring-0 disabled:opacity-100'
                                {...form.register(
                                  `provider_credentials.${index}.apiKey`,
                                )}
                              />
                            )}
                            {field.provider === 'ollama' && (
                              <Input
                                id={`model-base-url-${field.provider}`}
                                type='url'
                                inputMode='url'
                                autoComplete='url'
                                aria-label={t(
                                  'settings.models.baseUrlPlaceholder',
                                )}
                                placeholder={t(
                                  'settings.models.baseUrlPlaceholder',
                                )}
                                className='text-muted-foreground border-none bg-transparent! pr-0 text-right outline-none focus-visible:border-none focus-visible:ring-0 disabled:opacity-100'
                                {...form.register(
                                  `provider_credentials.${index}.baseUrl`,
                                )}
                              />
                            )}
                          </div>
                          <ChevronRightIcon className='size-4' />
                        </ItemActions>
                      </Item>
                    </FieldLabel>
                  </Field>
                ))}
              </>
            )}
          />
        </FieldGroup>
      </div>
      <Controller
        name='summary_model_profile_id'
        control={form.control}
        render={({ field }) => (
          <Field className='pt-4'>
            <FieldLabel htmlFor='summary-model-profile'>
              {t('settings.models.summaryModel')}
            </FieldLabel>
            <FieldDescription>
              {t('settings.models.summaryModelDescription')}
            </FieldDescription>
            <Select
              value={field.value || NO_SUMMARY_MODEL}
              onValueChange={(value) =>
                field.onChange(value === NO_SUMMARY_MODEL ? '' : value)
              }
            >
              <SelectTrigger id='summary-model-profile' className='w-full'>
                <span className='flex-1 truncate text-left'>
                  {modelProfiles.find((profile) => profile.id === field.value)
                    ?.name ?? t('settings.models.summaryModelNone')}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SUMMARY_MODEL}>
                  {t('settings.models.summaryModelNone')}
                </SelectItem>
                {Object.entries(
                  modelProfiles.reduce<
                    Partial<Record<ModelProvider, ModelDefinition[]>>
                  >((groups, profile) => {
                    (groups[profile.provider] ??= []).push(profile);
                    return groups;
                  }, {}),
                ).map(([provider, profiles]) => (
                  <SelectGroup key={provider}>
                    <SelectLabel>
                      {MODEL_PROVIDER_LABEL[provider as ModelProvider]}
                    </SelectLabel>
                    {profiles?.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name} · {profile.model}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      />
    </FieldSet>
  );
}

export { ModelProfilesSettings };
