import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription as AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle as AlertDialogHeading,
  Spinner,
} from '@workspace/ui/components';
import { useTranslation } from 'react-i18next';

import type { EvaluationCase, EvaluationSuite } from '@/services/evaluation';

export function DeleteSuiteDialog({
  suite,
  saving,
  onOpenChange,
  onConfirm,
}: {
  suite?: EvaluationSuite;
  saving: boolean;
  onOpenChange: (suite?: EvaluationSuite) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <AlertDialog
      open={Boolean(suite)}
      onOpenChange={(open) => !open && onOpenChange(undefined)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogHeading>
            {t('evaluations.deleteSuiteTitle')}
          </AlertDialogHeading>
          <AlertDialogBody>
            {t('evaluations.deleteSuiteDescription', { name: suite?.name })}
          </AlertDialogBody>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant='destructive'
            disabled={saving}
            onClick={onConfirm}
          >
            {saving ? <Spinner /> : null} {t('evaluations.deleteSuite')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteCaseDialog({
  evaluationCase,
  onOpenChange,
  onConfirm,
}: {
  evaluationCase?: EvaluationCase;
  onOpenChange: (evaluationCase?: EvaluationCase) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <AlertDialog
      open={Boolean(evaluationCase)}
      onOpenChange={(open) => !open && onOpenChange(undefined)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogHeading>
            {t('evaluations.deleteCaseTitle')}
          </AlertDialogHeading>
          <AlertDialogBody>
            {t('evaluations.deleteCaseDescription', {
              name: evaluationCase?.name,
            })}
          </AlertDialogBody>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('evaluations.deleteCase')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
