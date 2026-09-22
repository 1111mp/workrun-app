import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from '@workspace/ui/components';
import { useTranslation } from 'react-i18next';

import type {
  EvaluationVersionCaseCriterionComparison,
  EvaluationVersionCaseDiff,
} from '@/services/evaluation';

import { VersionCriterionComparison } from './result-details';

export function VersionDiffDialog({
  diff,
  comparison,
  loading,
  baselineLabel,
  candidateLabel,
  nodeNames,
  routeNames,
  toolNames,
  onOpenChange,
}: {
  diff?: EvaluationVersionCaseDiff;
  comparison?: EvaluationVersionCaseCriterionComparison;
  loading: boolean;
  baselineLabel: string;
  candidateLabel: string;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
  toolNames: Record<string, string>;
  onOpenChange: (diff?: EvaluationVersionCaseDiff) => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={Boolean(diff)}
      onOpenChange={(open) => !open && onOpenChange(undefined)}
    >
      <DialogContent className='max-h-[calc(100dvh-2rem)] max-w-5xl! gap-0 overflow-hidden p-0'>
        <DialogHeader className='border-b bg-linear-to-br from-rose-500/10 to-amber-500/10 px-6 py-5 pr-14'>
          <DialogTitle className='text-lg'>
            {t('evaluations.regressionLocation')}
          </DialogTitle>
          <DialogDescription className='mt-1'>{diff?.name}</DialogDescription>
        </DialogHeader>
        <div className='max-h-140 overflow-y-auto px-6 py-5'>
          {loading ? (
            <div className='text-muted-foreground flex items-center gap-2 py-8 text-sm'>
              <Spinner className='size-4' />
              {t('evaluations.loadingRegressionLocation')}
            </div>
          ) : comparison ? (
            <VersionCriterionComparison
              comparison={comparison}
              baselineLabel={baselineLabel}
              candidateLabel={candidateLabel}
              nodeNames={nodeNames}
              routeNames={routeNames}
              toolNames={toolNames}
            />
          ) : (
            <p className='text-muted-foreground py-8 text-sm'>
              {t('evaluations.noCriterionDifferences')}
            </p>
          )}
        </div>
        <DialogFooter className='mx-0 mb-0'>
          <Button variant='outline' onClick={() => onOpenChange(undefined)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
