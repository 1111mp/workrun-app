import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  deleteRemoteCredential,
  listRemoteCredentials,
  saveRemoteCredential,
  testRemoteConnection,
  type RemoteAuthentication,
} from '@/services/remote-agent';

export function RemoteAgentAuthenticationFields({
  url,
  authentication,
  onChange,
}: {
  url: string;
  authentication?: RemoteAuthentication;
  onChange: (authentication: RemoteAuthentication) => void;
}) {
  const { t } = useTranslation();
  const auth = authentication ?? { type: 'none' as const };
  // Base UI needs labels on the root before the popup items are mounted.
  const authenticationItems = [
    { value: 'none', label: t('workflowEditor.remoteAuth.none') },
    { value: 'bearer', label: 'Bearer Token' },
    { value: 'apiKey', label: 'API Key' },
  ];
  const credentials = useQuery({
    queryKey: ['remote-agent-credentials'],
    queryFn: listRemoteCredentials,
  });
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failed, setFailed] = useState(false);
  const id = auth.type === 'none' ? '' : auth.credentialId;
  const selected = credentials.data?.find((credential) => credential.id === id);
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    /* The native connection check explains invalid URLs. */
  }
  const matches = selected?.kind === auth.type && selected?.origin === origin;
  const choices =
    credentials.data?.filter((credential) => credential.kind === auth.type) ??
    [];
  const change = (value: RemoteAuthentication) => {
    setSecret('');
    setEditing(null);
    setFeedback('');
    onChange(value);
  };
  const choose = (credentialId: string) =>
    change(
      auth.type === 'apiKey'
        ? { type: 'apiKey', credentialId, headerName: auth.headerName }
        : { type: 'bearer', credentialId },
    );
  const perform = async (action: () => Promise<void>) => {
    setPending(true);
    setFeedback('');
    setFailed(false);
    try {
      await action();
    } catch (error) {
      setFailed(true);
      setFeedback(String(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>{t('workflowEditor.remoteAuth.mode')}</FieldLabel>
        <Select
          items={authenticationItems}
          value={auth.type}
          disabled={pending}
          onValueChange={(type) =>
            change(
              type === 'apiKey'
                ? { type: 'apiKey', credentialId: '', headerName: 'X-API-Key' }
                : type === 'bearer'
                  ? { type: 'bearer', credentialId: '' }
                  : { type: 'none' },
            )
          }
        >
          <SelectTrigger aria-label={t('workflowEditor.remoteAuth.mode')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {authenticationItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          {t('workflowEditor.remoteAuth.description')}
        </FieldDescription>
      </Field>
      {auth.type !== 'none' && (
        <>
          <Field data-invalid={!!id && !matches}>
            <FieldLabel>{t('workflowEditor.remoteAuth.credential')}</FieldLabel>
            <Select
              items={choices.map((credential) => ({
                value: credential.id,
                label: credential.name,
              }))}
              value={id || null}
              disabled={pending || credentials.isLoading}
              onValueChange={(value) => {
                if (value) choose(value);
              }}
            >
              <SelectTrigger
                aria-label={t('workflowEditor.remoteAuth.credential')}
                aria-invalid={!!id && !matches}
              >
                <SelectValue
                  placeholder={t('workflowEditor.remoteAuth.select')}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {choices.map((credential) => (
                    <SelectItem
                      key={credential.id}
                      value={credential.id}
                      disabled={credential.origin !== origin}
                    >
                      {credential.name}
                      {credential.origin !== origin &&
                        ` (${credential.origin})`}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {!origin && (
              <FieldDescription>
                {t('workflowEditor.remoteAuth.enterUrl')}
              </FieldDescription>
            )}
            {origin &&
              choices.length > 0 &&
              !choices.some((credential) => credential.origin === origin) && (
                <FieldDescription>
                  {t('workflowEditor.remoteAuth.originMismatch')}
                </FieldDescription>
              )}
            {id && !matches && (
              <FieldDescription>
                {t('workflowEditor.remoteAuth.missing')}
              </FieldDescription>
            )}
            {credentials.isError && (
              <FieldDescription>
                {t('workflowEditor.remoteAuth.loadFailed')}
              </FieldDescription>
            )}
          </Field>
          {auth.type === 'apiKey' && (
            <Field>
              <FieldLabel htmlFor='remote-api-header'>
                {t('workflowEditor.remoteAuth.header')}
              </FieldLabel>
              <Input
                id='remote-api-header'
                value={auth.headerName}
                disabled={pending}
                onChange={(event) => {
                  setFeedback('');
                  onChange({ ...auth, headerName: event.target.value });
                }}
              />
            </Field>
          )}
          <div className='flex flex-wrap gap-2'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={pending}
              onClick={() => {
                setEditing('new');
                setName('');
                setSecret('');
                setFeedback('');
              }}
            >
              {t('workflowEditor.remoteAuth.add')}
            </Button>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={pending || !matches}
              onClick={() => {
                setEditing('edit');
                setName(selected?.name ?? '');
                setSecret('');
                setFeedback('');
              }}
            >
              {t('workflowEditor.remoteAuth.edit')}
            </Button>
          </div>
          {editing && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor='remote-credential-name'>
                  {t('workflowEditor.remoteAuth.name')}
                </FieldLabel>
                <Input
                  id='remote-credential-name'
                  autoComplete='off'
                  value={name}
                  disabled={pending}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor='remote-credential-secret'>
                  {auth.type === 'bearer' ? 'Bearer Token' : 'API Key'}
                </FieldLabel>
                <Input
                  id='remote-credential-secret'
                  type='password'
                  autoComplete='new-password'
                  value={secret}
                  disabled={pending}
                  onChange={(event) => setSecret(event.target.value)}
                />
                <FieldDescription>
                  {t(
                    editing === 'edit'
                      ? 'workflowEditor.remoteAuth.keepSecret'
                      : 'workflowEditor.remoteAuth.writeOnly',
                  )}
                </FieldDescription>
              </Field>
              <div className='flex flex-wrap gap-2'>
                <Button
                  type='button'
                  size='sm'
                  disabled={
                    pending || !name.trim() || (editing === 'new' && !secret)
                  }
                  onClick={() =>
                    void perform(async () => {
                      const saved = await saveRemoteCredential({
                        id: editing === 'edit' ? id : undefined,
                        name,
                        kind: auth.type,
                        serviceUrl: url,
                        secret: secret || undefined,
                      });
                      setSecret('');
                      setEditing(null);
                      await credentials.refetch();
                      choose(saved.id);
                      setFeedback(t('workflowEditor.remoteAuth.saved'));
                    })
                  }
                >
                  {t('workflowEditor.remoteAuth.save')}
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={pending}
                  onClick={() => {
                    setEditing(null);
                    setSecret('');
                  }}
                >
                  {t('workflowEditor.remoteAuth.cancel')}
                </Button>
                {editing === 'edit' && (
                  <Button
                    type='button'
                    variant='destructive'
                    size='sm'
                    disabled={pending}
                    onClick={() =>
                      void perform(async () => {
                        await deleteRemoteCredential(id);
                        setSecret('');
                        setEditing(null);
                        choose('');
                        await credentials.refetch();
                        setFeedback(t('workflowEditor.remoteAuth.deleted'));
                      })
                    }
                  >
                    {t('workflowEditor.remoteAuth.delete')}
                  </Button>
                )}
              </div>
            </FieldGroup>
          )}
        </>
      )}
      <Button
        type='button'
        variant='outline'
        size='sm'
        disabled={
          pending ||
          !url.trim() ||
          editing !== null ||
          (auth.type !== 'none' && !id)
        }
        onClick={() =>
          void perform(async () => {
            await testRemoteConnection(url, auth);
            setFeedback(t('workflowEditor.remoteAuth.connected'));
          })
        }
      >
        {t(
          pending
            ? 'workflowEditor.remoteAuth.working'
            : 'workflowEditor.remoteAuth.test',
        )}
      </Button>
      {feedback && (
        <p role={failed ? 'alert' : 'status'} className='text-sm'>
          {feedback}
        </p>
      )}
    </FieldGroup>
  );
}
