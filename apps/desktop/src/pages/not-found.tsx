import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@workspace/ui/components';
import { HomeIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

function NotFoundPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <Empty className='size-full'>
      <EmptyHeader>
        <EmptyTitle className='text-2xl'>{t('notFound.title')}</EmptyTitle>
        <EmptyDescription>{t('notFound.description')}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={() => navigate('/workflow')}>
          <HomeIcon className='mr-2 size-4' />
          {t('notFound.backHome')}
        </Button>
        <EmptyDescription>
          {t('notFound.needHelp')}{' '}
          <a
            href='https://github.com/1111mp/workrun-app/issues?q=is%3Aissue'
            target='_blank'
            rel='noopener noreferrer'
          >
            {t('notFound.contactSupport')}
          </a>
        </EmptyDescription>
      </EmptyContent>
    </Empty>
  );
}

export { NotFoundPage as Component };
