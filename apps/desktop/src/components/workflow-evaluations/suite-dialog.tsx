import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Spinner,
  Textarea,
} from '@workspace/ui/components';
import { BeakerIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { EvaluationSuite } from '@/services/evaluation';

export function SuiteDialog({
  open,
  suite,
  name,
  description,
  saving,
  onOpenChange,
  onNameChange,
  onDescriptionChange,
  onSave,
}: {
  open: boolean;
  suite?: EvaluationSuite;
  name: string;
  description: string;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className='max-w-xl! gap-0 overflow-hidden p-0'
        showCloseButton={!saving}
      >
        <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-sky-500/12 to-violet-500/10 px-6 py-6 pr-14'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.16)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
          <div className='relative flex items-start gap-3'>
            <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 text-sky-700 shadow-sm dark:text-sky-300'>
              <BeakerIcon className='size-5' />
            </div>
            <div className='min-w-0'>
              <DialogTitle className='text-lg'>
                {suite ? t('evaluations.editSuite') : t('evaluations.newSuite')}
              </DialogTitle>
              <DialogDescription className='mt-1 max-w-md leading-5'>
                {t('evaluations.suiteDescription')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className='px-6 py-6'>
          <FieldSet className='bg-muted/20 rounded-xl border p-4 sm:p-5'>
            <FieldLegend>{t('evaluations.suiteDetails')}</FieldLegend>
            <FieldDescription>
              {t('evaluations.suiteDetailsDescription')}
            </FieldDescription>
            <FieldGroup className='mt-5 gap-5'>
              <Field>
                <FieldLabel htmlFor='evaluation-suite-name'>
                  {t('common.name')}
                </FieldLabel>
                <Input
                  id='evaluation-suite-name'
                  value={name}
                  placeholder={t('evaluations.suiteNamePlaceholder')}
                  onChange={(event) => onNameChange(event.target.value)}
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor='evaluation-suite-description'>
                  {t('common.description')}{' '}
                  <span className='text-muted-foreground font-normal'>
                    {t('common.optional')}
                  </span>
                </FieldLabel>
                <Textarea
                  id='evaluation-suite-description'
                  className='min-h-24 resize-y'
                  placeholder={t('evaluations.suiteDescriptionPlaceholder')}
                  value={description}
                  onChange={(event) => onDescriptionChange(event.target.value)}
                />
              </Field>
            </FieldGroup>
          </FieldSet>
        </div>
        <DialogFooter className='mx-0 mb-0'>
          <Button
            variant='outline'
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button disabled={!name.trim() || saving} onClick={onSave}>
            {saving ? <Spinner /> : null}{' '}
            {suite ? t('evaluations.saveSuite') : t('evaluations.createSuite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
