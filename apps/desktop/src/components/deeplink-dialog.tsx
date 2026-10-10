import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@workspace/ui/components';
import { CopyIcon, LinkIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { JsonEditorField } from '@/components/json-editor/json-editor-field';
import { createDeeplink, type LinkRequest } from '@/services/deeplink';

export function DeeplinkDialog({
  targetType,
  targetId,
  disabled,
  open: controlledOpen,
  onOpenChange,
}: {
  targetType: LinkRequest['targetType'];
  targetId: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [inputText, setInputText] = useState('{}');
  const { t } = useTranslation();
  let input: Record<string, unknown> | undefined;
  let invalid = false;
  try {
    const parsed: unknown = JSON.parse(inputText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      invalid = true;
    else input = parsed as Record<string, unknown>;
  } catch {
    invalid = true;
  }
  const openLink = createDeeplink(targetType, targetId, 'open');
  let runLink = '';
  let linkError: string | undefined;
  try {
    runLink = createDeeplink(
      targetType,
      targetId,
      'run',
      targetType === 'workflows' ? input : undefined,
    );
  } catch (error) {
    linkError = error instanceof Error ? error.message : String(error);
  }
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('deeplink.copied'), { toasterId: 'global' });
    } catch (error) {
      toast.error(String(error), { toasterId: 'global' });
    }
  };
  return (
    <>
      {controlledOpen === undefined ? (
        <Button
          variant='outline'
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <LinkIcon data-icon='inline-start' />
          {t('deeplink.title')}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl! gap-0 overflow-y-auto p-0'>
          <div className='via-background from-primary/12 to-muted/50 relative overflow-hidden border-b bg-linear-to-br px-5 pt-5 pb-4 sm:px-6 sm:pt-6'>
            <div className='bg-primary/10 absolute -top-12 -right-10 size-36 rounded-full blur-2xl' />
            <DialogHeader className='relative flex-row items-start gap-3 text-left'>
              <span className='border-primary/20 bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl border shadow-sm'>
                <LinkIcon className='size-5' />
              </span>
              <div className='flex min-w-0 flex-col gap-1.5 pr-6'>
                <DialogTitle className='text-lg font-semibold tracking-tight'>
                  {t('deeplink.title')}
                </DialogTitle>
                <DialogDescription className='text-sm leading-5'>
                  {t('deeplink.description')}
                </DialogDescription>
              </div>
            </DialogHeader>
          </div>
          <div className='px-5 py-5 sm:px-6'>
            <FieldGroup>
              {targetType === 'workflows' ? (
                <Field data-invalid={invalid || undefined}>
                  <FieldLabel>{t('deeplink.input')}</FieldLabel>
                  <FieldDescription>
                    {t('deeplink.inputDescription')}
                  </FieldDescription>
                  <JsonEditorField
                    value={inputText}
                    onChange={setInputText}
                    rootName='input'
                    rootType='object'
                  />
                  {invalid ? (
                    <p role='alert' className='text-destructive text-sm'>
                      {t('deeplink.invalidInput')}
                    </p>
                  ) : null}
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor='deeplink-open'>
                  {t('deeplink.openLink')}
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id='deeplink-open'
                    className='font-mono text-xs'
                    readOnly
                    value={openLink}
                  />
                  <InputGroupAddon align='inline-end'>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => void copy(openLink)}
                    >
                      <CopyIcon data-icon='inline-start' />
                      {t('deeplink.copyOpen')}
                    </Button>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor='deeplink-run'>
                  {t('deeplink.runLink')}
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id='deeplink-run'
                    className='font-mono text-xs'
                    readOnly
                    value={runLink}
                  />
                  <InputGroupAddon align='inline-end'>
                    <Button
                      variant='ghost'
                      size='sm'
                      disabled={
                        Boolean(linkError) ||
                        (targetType === 'workflows' && invalid)
                      }
                      onClick={() => void copy(runLink)}
                    >
                      <CopyIcon data-icon='inline-start' />
                      {t('deeplink.copyRun')}
                    </Button>
                  </InputGroupAddon>
                </InputGroup>
                {linkError ? (
                  <p role='alert' className='text-destructive text-sm'>
                    {linkError}
                  </p>
                ) : null}
              </Field>
            </FieldGroup>
          </div>
          <DialogFooter className='bg-muted/15 mx-0 mb-0 border-t px-5 py-4 sm:px-6'>
            <Button variant='outline' onClick={() => setOpen(false)}>
              {t('apps.share.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
