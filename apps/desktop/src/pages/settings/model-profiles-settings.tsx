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
} from '@workspace/ui/components';
import { ChevronRightIcon } from 'lucide-react';
import { useWatch, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import type { SettingsForm } from './settings-schema';

const PROVIDER_SETTINGS = [
  { key: 'gemini', providers: ['gemini'] },
  { key: 'openAi', providers: ['open_ai', 'open_ai_strict'] },
  { key: 'anthropic', providers: ['anthropic'] },
  { key: 'deepSeek', providers: ['deep_seek'] },
] as const satisfies ReadonlyArray<{
  key: string;
  providers: ReadonlyArray<ModelProvider>;
}>;

function ModelProfilesSettings({
  form,
}: {
  form: UseFormReturn<SettingsForm>;
}) {
  const { t } = useTranslation();
  const profiles = useWatch({
    control: form.control,
    name: 'provider_credentials',
  });

  return (
    <FieldSet className='gap-1'>
      <FieldLegend className='text-muted-foreground pl-3'>
        {t('settings.models.title')}
      </FieldLegend>
      <FieldDescription className='pl-3'>
        {t('settings.models.description')}
      </FieldDescription>
      <div className='overflow-hidden rounded-xl'>
        <FieldGroup className='gap-0'>
          {PROVIDER_SETTINGS.map(({ key, providers }) => (
            <ProviderApiKeyField
              key={key}
              id={key}
              form={form}
              profiles={profiles}
              providers={providers}
              label={t(`settings.models.${key}`)}
              // description={t('settings.models.modelCount', {
              //   count: providers.length,
              // })}
            />
          ))}
        </FieldGroup>
      </div>
    </FieldSet>
  );
}

function ProviderApiKeyField({
  id,
  form,
  profiles,
  providers,
  label,
  // description,
}: {
  id: string;
  form: UseFormReturn<SettingsForm>;
  profiles: SettingsForm['provider_credentials'];
  providers: ReadonlyArray<ModelProvider>;
  label: string;
  // description: string;
}) {
  const apiKey =
    profiles.find((profile) => providers.includes(profile.provider))?.apiKey ??
    '';

  return (
    <Field>
      <FieldLabel htmlFor={`model-api-key-${id}`}>
        <Item
          variant='muted'
          size='sm'
          className='hover:bg-muted rounded-none py-1.5'
        >
          <ItemContent>
            <ItemTitle>{label}</ItemTitle>
            {/* <ItemDescription>{description}</ItemDescription> */}
          </ItemContent>
          <ItemActions>
            <Input
              id={`model-api-key-${id}`}
              // type='password'
              value={apiKey}
              autoComplete='off'
              placeholder='请输入'
              className='text-muted-foreground border-none bg-transparent! pr-0 text-right outline-none focus-visible:border-none focus-visible:ring-0 disabled:opacity-100'
              onChange={(event) => {
                const provider = providers[0];
                const index = profiles.findIndex(
                  (profile) => profile.provider === provider,
                );
                if (index >= 0) {
                  form.setValue(
                    `provider_credentials.${index}.apiKey`,
                    event.target.value,
                  );
                } else {
                  form.setValue('provider_credentials', [
                    ...profiles,
                    { provider, apiKey: event.target.value },
                  ]);
                }
              }}
            />
            <ChevronRightIcon className='size-4' />
          </ItemActions>
        </Item>
      </FieldLabel>
    </Field>
  );
}

export { ModelProfilesSettings };
