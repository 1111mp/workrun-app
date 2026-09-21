import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@workspace/ui/components';
import { useTranslation } from 'react-i18next';

import type { EvaluationSuite } from '@/services/evaluation';

import type { ImportConflictStrategy, TestImportPreview } from './types';

export function EvaluationImportDialog({
  preview,
  suites,
  suiteStrategy,
  caseStrategy,
  importing,
  onOpenChange,
  onSuiteStrategyChange,
  onCaseStrategyChange,
  onConfirm,
}: {
  preview?: TestImportPreview;
  suites: EvaluationSuite[];
  suiteStrategy: ImportConflictStrategy;
  caseStrategy: ImportConflictStrategy;
  importing: boolean;
  onOpenChange: (preview?: TestImportPreview) => void;
  onSuiteStrategyChange: (strategy: ImportConflictStrategy) => void;
  onCaseStrategyChange: (strategy: ImportConflictStrategy) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={Boolean(preview)}
      onOpenChange={(open) => !open && !importing && onOpenChange(undefined)}
    >
      <DialogContent className='max-w-2xl! gap-0 overflow-hidden p-0'>
        <DialogHeader className='border-b bg-linear-to-br from-sky-500/10 to-violet-500/10 px-6 py-5'>
          <DialogTitle>{t('evaluations.importPreview')}</DialogTitle>
          <DialogDescription>
            {t('evaluations.importPreviewDescription')}
          </DialogDescription>
        </DialogHeader>
        {preview ? (
          <div className='max-h-[60vh] space-y-5 overflow-y-auto px-6 py-5'>
            <div className='rounded-lg border border-sky-500/20 bg-sky-500/5 p-3'>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <span className='font-medium'>{preview.suiteName}</span>
                <Badge variant='outline'>
                  {t('evaluations.caseCount', {
                    count: preview.cases.length,
                  })}
                </Badge>
              </div>
              {preview.suiteDescription ? (
                <p className='text-muted-foreground mt-1 text-sm'>
                  {preview.suiteDescription}
                </p>
              ) : null}
            </div>
            {preview.errors.length ? (
              <div className='border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-3 text-sm'>
                {preview.errors.map((error) => (
                  <p key={error}>• {error}</p>
                ))}
              </div>
            ) : null}
            {suites.some((item) => item.name === preview.suiteName) ? (
              <Field>
                <FieldLabel>{t('evaluations.sameNameSuite')}</FieldLabel>
                <Select
                  value={suiteStrategy}
                  onValueChange={(value) =>
                    onSuiteStrategyChange(
                      (value ?? 'create') as ImportConflictStrategy,
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='create'>
                      {t('evaluations.importSuiteCreate')}
                    </SelectItem>
                    <SelectItem value='overwrite'>
                      {t('evaluations.importSuiteOverwrite')}
                    </SelectItem>
                    <SelectItem value='skip'>
                      {t('evaluations.importSkip')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field>
              <FieldLabel>{t('evaluations.sameNameCase')}</FieldLabel>
              <Select
                value={caseStrategy}
                onValueChange={(value) =>
                  onCaseStrategyChange(
                    (value ?? 'create') as ImportConflictStrategy,
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='create'>
                    {t('evaluations.importCaseCreate')}
                  </SelectItem>
                  <SelectItem value='overwrite'>
                    {t('evaluations.importCaseOverwrite')}
                  </SelectItem>
                  <SelectItem value='skip'>
                    {t('evaluations.importCaseSkip')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className='space-y-2'>
              <p className='text-sm font-medium'>
                {t('evaluations.caseValidation')}
              </p>
              {preview.cases.map((item) => (
                <div
                  key={item.index}
                  className={`rounded-lg border px-3 py-2 text-sm ${item.errors.length ? 'border-destructive/30 bg-destructive/5' : 'bg-muted/30'}`}
                >
                  <div className='flex items-center justify-between gap-3'>
                    <span className='truncate font-medium'>{item.name}</span>
                    <Badge variant='outline'>
                      {item.errors.length
                        ? t('evaluations.invalid')
                        : t('evaluations.valid')}
                    </Badge>
                  </div>
                  {item.errors.map((error) => (
                    <p key={error} className='text-destructive mt-1 text-xs'>
                      {error}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <DialogFooter className='mx-0 mb-0'>
          <Button
            variant='outline'
            disabled={importing}
            onClick={() => onOpenChange(undefined)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            disabled={
              importing ||
              !preview ||
              preview.errors.length > 0 ||
              preview.cases.some((item) => item.errors.length > 0)
            }
            onClick={onConfirm}
          >
            {importing ? <Spinner data-icon='inline-start' /> : null}
            {t('evaluations.confirmImport')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
