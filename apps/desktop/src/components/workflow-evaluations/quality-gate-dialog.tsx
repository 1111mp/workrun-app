import {
  Button,
  Checkbox,
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
  Label,
} from '@workspace/ui/components';
import { ShieldCheckIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  EvaluationQualityGate,
  EvaluationSuite,
} from '@/services/evaluation';

export function QualityGateDialog({
  open,
  qualityGate,
  suites,
  onOpenChange,
  setQualityGate,
  onSave,
}: {
  open: boolean;
  qualityGate: EvaluationQualityGate;
  suites: EvaluationSuite[];
  onOpenChange: (open: boolean) => void;
  setQualityGate: Dispatch<SetStateAction<EvaluationQualityGate>>;
  onSave: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-2xl! gap-0 overflow-hidden p-0'>
        <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-amber-500/12 to-violet-500/10 px-6 py-6 pr-14'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(38_92%_50%/0.14)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
          <div className='relative flex items-start gap-3'>
            <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 text-amber-700 shadow-sm dark:text-amber-300'>
              <ShieldCheckIcon className='size-5' />
            </div>
            <div>
              <DialogTitle className='text-lg'>
                {t('evaluations.qualityGate')}
              </DialogTitle>
              <DialogDescription className='mt-1 max-w-xl leading-5'>
                {t('evaluations.gateDescription')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className='max-h-[min(68vh,620px)] overflow-y-auto px-6 py-6'>
          <FieldGroup className='gap-7'>
            <Field orientation='horizontal'>
              <Checkbox
                id='gate-require-evaluation'
                checked={qualityGate.requireEvaluation}
                onCheckedChange={(checked) =>
                  setQualityGate((current) => ({
                    ...current,
                    requireEvaluation: checked === true,
                  }))
                }
              />
              <FieldLabel htmlFor='gate-require-evaluation'>
                {t('evaluations.requireEvaluation')}
              </FieldLabel>
            </Field>
            <FieldSet className='rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 sm:p-5'>
              <FieldLegend>{t('evaluations.overallThresholds')}</FieldLegend>
              <FieldDescription>
                {t('evaluations.thresholdDescription')}
              </FieldDescription>
              <div className='mt-4 grid gap-4 sm:grid-cols-3'>
                <Field>
                  <FieldLabel>{t('evaluations.minimumPassRate')}</FieldLabel>
                  <Input
                    type='number'
                    min={0}
                    max={100}
                    value={
                      qualityGate.minPassRate == null
                        ? ''
                        : qualityGate.minPassRate * 100
                    }
                    onChange={(event) =>
                      setQualityGate((current) => ({
                        ...current,
                        minPassRate:
                          event.target.value === ''
                            ? null
                            : Number(event.target.value) / 100,
                      }))
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel>{t('evaluations.maximumCost')}</FieldLabel>
                  <Input
                    type='number'
                    min={0}
                    step='0.01'
                    value={
                      qualityGate.maxCostMicrousd == null
                        ? ''
                        : qualityGate.maxCostMicrousd / 1_000_000
                    }
                    onChange={(event) =>
                      setQualityGate((current) => ({
                        ...current,
                        maxCostMicrousd:
                          event.target.value === ''
                            ? null
                            : Math.round(
                                Number(event.target.value) * 1_000_000,
                              ),
                      }))
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel>{t('evaluations.maximumDuration')}</FieldLabel>
                  <Input
                    type='number'
                    min={0}
                    value={
                      qualityGate.maxDurationMs == null
                        ? ''
                        : qualityGate.maxDurationMs / 1000
                    }
                    onChange={(event) =>
                      setQualityGate((current) => ({
                        ...current,
                        maxDurationMs:
                          event.target.value === ''
                            ? null
                            : Math.round(Number(event.target.value) * 1000),
                      }))
                    }
                  />
                </Field>
              </div>
            </FieldSet>
            <FieldSet className='rounded-xl border p-4 sm:p-5'>
              <FieldLegend>{t('evaluations.requiredSuites')}</FieldLegend>
              <FieldDescription>
                {t('evaluations.requiredSuitesDescription')}
              </FieldDescription>
              <FieldGroup className='mt-2 gap-2'>
                {suites.map((suite) => (
                  <Field key={suite.id} orientation='horizontal'>
                    <Checkbox
                      id={`gate-suite-${suite.id}`}
                      checked={qualityGate.requiredSuiteIds.includes(suite.id)}
                      onCheckedChange={(checked) =>
                        setQualityGate((current) => ({
                          ...current,
                          requiredSuiteIds:
                            checked === true
                              ? [...current.requiredSuiteIds, suite.id]
                              : current.requiredSuiteIds.filter(
                                  (id) => id !== suite.id,
                                ),
                        }))
                      }
                    />
                    <Label htmlFor={`gate-suite-${suite.id}`}>
                      {suite.name}
                    </Label>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>
          </FieldGroup>
        </div>
        <DialogFooter className='mx-0 mb-0'>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onSave}>{t('evaluations.saveQualityGate')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
