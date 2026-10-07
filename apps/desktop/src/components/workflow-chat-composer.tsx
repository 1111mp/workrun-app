import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
  Spinner,
} from '@workspace/ui/components';
import { ArrowUpIcon, PaperclipIcon, PlusIcon } from 'lucide-react';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ArtifactFiles } from '@/components/artifact-files';
import {
  artifactReferences,
  pickArtifacts,
  type ArtifactRef,
} from '@/services/artifact';

export function WorkflowChatComposer({
  fileInputs,
  filesForInput,
  onFileChange,
  message,
  onMessageChange,
  disabled,
  onSubmit,
}: {
  fileInputs: WorkflowInput[];
  filesForInput: (key: string) => unknown;
  onFileChange: (
    key: string,
    value: ArtifactRef | ArtifactRef[] | null,
  ) => void;
  message: string;
  onMessageChange: (value: string) => void;
  disabled: boolean;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function pick(field: WorkflowInput) {
    if (disabled || busy.current) return;
    busy.current = true;
    setPicking(true);
    try {
      const selected = await pickArtifacts(field.type === 'files');
      // Cancellation keeps existing attachments; multi-file inputs accumulate selections.
      if (mounted.current && selected.length) {
        onFileChange(
          field.key,
          field.type === 'files'
            ? artifactReferences([
                ...artifactReferences(filesForInput(field.key)),
                ...selected,
              ])
            : selected[0]!,
        );
      }
    } catch (error) {
      if (mounted.current) toast.error(String(error), { toasterId: 'global' });
    } finally {
      busy.current = false;
      if (mounted.current) setPicking(false);
    }
  }
  const attachedFields = fileInputs.filter(
    (field) => artifactReferences(filesForInput(field.key)).length,
  );
  return (
    <form
      className='w-full'
      onSubmit={(event) => {
        if (disabled || busy.current) event.preventDefault();
        else onSubmit(event);
      }}
    >
      <InputGroup className='rounded-3xl'>
        {attachedFields.length > 0 && (
          <InputGroupAddon
            align='block-start'
            className='max-h-48 overflow-y-auto px-3 pt-3'
          >
            <div className='flex min-w-0 flex-wrap gap-2'>
              {attachedFields.map((field) => (
                <div key={field.id} className='max-w-full min-w-0'>
                  {fileInputs.length > 1 && (
                    <span className='text-muted-foreground mb-1 block text-xs'>
                      {field.label}
                    </span>
                  )}
                  <ArtifactFiles
                    compact
                    hidePicker
                    value={filesForInput(field.key)}
                    multiple={field.type === 'files'}
                    disabled={disabled || picking}
                    onChange={(value) => onFileChange(field.key, value ?? null)}
                  />
                </div>
              ))}
            </div>
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          className='max-h-52 min-h-20 px-4 pt-3'
          aria-label={t('workflowEditor.output.message')}
          disabled={disabled || picking}
          placeholder={t('workflowEditor.output.messagePlaceholder')}
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          onKeyDown={(event) => {
            // IME Enter confirms Chinese/Japanese composition rather than sending a turn.
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <InputGroupAddon
          align='block-end'
          className='justify-between px-3 pb-3'
        >
          <div className='flex min-w-0 items-center gap-3'>
            {fileInputs.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <InputGroupButton
                      size='icon-sm'
                      variant='outline'
                      className='border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-input/30 flex size-8 items-center gap-2 rounded-2xl p-0 text-sm shadow-none has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 has-[>svg]:p-0 dark:bg-transparent'
                      disabled={disabled || picking}
                      aria-label={t('workflowEditor.artifacts.add')}
                    />
                  }
                >
                  {picking ? <Spinner /> : <PlusIcon />}
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side='top'
                  align='start'
                  className='w-max max-w-80'
                >
                  <DropdownMenuGroup>
                    {fileInputs.map((field) => (
                      <DropdownMenuItem
                        key={field.id}
                        onClick={() => void pick(field)}
                      >
                        <PaperclipIcon />
                        <span className='min-w-0 truncate'>
                          {fileInputs.length === 1
                            ? t('workflowEditor.artifacts.add')
                            : field.label}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <InputGroupText className='hidden truncate text-xs sm:flex'>
              {t('workflowEditor.output.sendHint')}
            </InputGroupText>
          </div>
          <InputGroupButton
            className='rounded-full'
            disabled={disabled || picking || !message.trim()}
            size='icon-sm'
            type='submit'
            variant='default'
            aria-label={t('workflowEditor.output.send')}
          >
            <ArrowUpIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
