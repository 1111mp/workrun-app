import { zodResolver } from '@hookform/resolvers/zod';
import {
  AlertDialogCancel,
  AlertDialogFooter,
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Spinner,
  Textarea,
} from '@workspace/ui/components';
import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import semver from 'semver';

import { z } from '@/lib/zod';

type AppPublishFormProps = {
  defaultVersion: string;
  isLoadingDefaultVersion: boolean;
  isSubmitting: boolean;
  onSubmit: (version: string, releaseNote: string) => Promise<void>;
};

export function AppPublishForm({
  defaultVersion,
  isLoadingDefaultVersion,
  isSubmitting,
  onSubmit,
}: AppPublishFormProps) {
  const { t } = useTranslation();

  const formSchema = useMemo(
    () =>
      z.object({
        version: z
          .string()
          .trim()
          .min(1, t('apps.detail.versionRequired'))
          .refine((value) => semver.valid(value) !== null, {
            message: t('apps.detail.versionInvalid'),
          }),
        releaseNote: z
          .string()
          .trim()
          .min(1, t('apps.detail.releaseNoteRequired')),
      }),
    [t],
  );

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { version: defaultVersion, releaseNote: '' },
  });

  useEffect(() => {
    // The version arrives after opening the dialog, so update the form default.
    form.reset({ version: defaultVersion, releaseNote: '' });
  }, [defaultVersion, form]);

  const onSubmitHandler = async ({
    version,
    releaseNote,
  }: z.infer<typeof formSchema>) => {
    try {
      await onSubmit?.(version, releaseNote);
    } catch (error) {
      form.setError('root', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmitHandler)}>
      <Controller
        name='version'
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor='process-node-publish-version'>
              {t('apps.detail.version')}
            </FieldLabel>
            <Input
              {...field}
              id='process-node-publish-version'
              disabled={isLoadingDefaultVersion || isSubmitting}
              aria-invalid={fieldState.invalid}
              onChange={(event) => {
                field.onChange(event);
                form.clearErrors('root');
              }}
            />
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        )}
      />
      <Controller
        name='releaseNote'
        control={form.control}
        render={({ field, fieldState }) => (
          <Field className='mt-4' data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor='process-node-publish-release-note'>
              {t('apps.detail.releaseNote')}
            </FieldLabel>
            <Textarea
              {...field}
              id='process-node-publish-release-note'
              disabled={isSubmitting}
              aria-invalid={fieldState.invalid}
              onChange={(event) => {
                field.onChange(event);
                form.clearErrors('root');
              }}
            />
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        )}
      />
      {/* {form.formState.errors.root?.message ? (
        <Alert className='mt-4' variant='destructive'>
          <CircleAlertIcon />
          <AlertDescription>
            {form.formState.errors.root.message}
          </AlertDescription>
        </Alert>
      ) : null} */}
      <AlertDialogFooter className='mt-6'>
        <AlertDialogCancel disabled={isSubmitting}>
          {t('apps.new.cancel')}
        </AlertDialogCancel>
        <Button
          disabled={isLoadingDefaultVersion || isSubmitting}
          type='submit'
        >
          {isSubmitting ? <Spinner data-icon='inline-start' /> : null}
          {t('apps.detail.publish')}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}
