import { CodeEditor } from '@json-edit-react/components/widgets';
import { githubDarkTheme, githubLightTheme } from '@json-edit-react/themes';
import { Button } from '@workspace/ui/components';
import { JsonEditor, JsonViewer, type ThemeStyles } from 'json-edit-react';
import { BracesIcon, CircleAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useWorkrunStore } from '@/stores';

export type JsonContainer = Record<string, unknown> | unknown[];

type JsonEditorFieldProps = {
  value?: string;
  onChange: (value: string) => void;
  rootName: string;
  rootType?: 'object' | 'array';
  className?: string;
};

const editorThemeOverrides: ThemeStyles = {
  container: {
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '0.75em',
    width: '100%',
  },
  input: {
    backgroundColor: 'var(--background)',
    border: '1px solid var(--input)',
    borderRadius: 'calc(var(--radius) * 0.6)',
  },
};

export function parseJsonContainer(
  value: string,
  rootType?: JsonEditorFieldProps['rootType'],
): JsonContainer | undefined {
  if (!value.trim()) return undefined;

  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (rootType === 'object' && Array.isArray(parsed)) ||
    (rootType === 'array' && !Array.isArray(parsed))
  ) {
    throw new Error('invalid root');
  }
  return parsed as JsonContainer;
}

/**
 * Bridges the string-backed JSON fields used by Workrun's save APIs with the
 * object-backed V2 editor. Keeping serialization here prevents individual
 * forms from drifting into subtly different JSON formatting or validation.
 */
export function JsonEditorField({
  value,
  onChange,
  rootName,
  rootType,
  className,
}: JsonEditorFieldProps) {
  const { t } = useTranslation();
  const resolvedTheme = useWorkrunStore((state) => state.resolvedTheme);
  const codeTheme = resolvedTheme === 'dark' ? 'Github Dark' : 'Github Light';
  // Preserve json-edit-react's official GitHub icons and syntax colours;
  // Workrun only adds layout and form-boundary styles on top.
  const jsonTheme =
    resolvedTheme === 'dark'
      ? [githubDarkTheme, editorThemeOverrides]
      : [githubLightTheme, editorThemeOverrides];
  // Optional draft fields use undefined before their first edit; treat that
  // exactly like an intentionally empty JSON field.
  const source = value ?? '';

  let data: JsonContainer | undefined;
  let invalid = false;
  try {
    data = parseJsonContainer(source, rootType);
  } catch {
    invalid = true;
  }

  if (invalid) {
    return (
      <div
        className={`workrun-json-editor border-destructive/40 bg-destructive/5 w-full max-w-none rounded-lg border p-3 ${className ?? ''}`}
      >
        <div className='text-destructive mb-2 flex items-center gap-2 text-xs'>
          <CircleAlertIcon className='size-3.5' />
          {t('jsonEditor.invalidSource')}
        </div>
        {/* Invalid saved input cannot be passed to JsonEditor; CodeMirror keeps it repairable. */}
        <CodeEditor
          value={source}
          onChange={onChange}
          onKeyDown={() => undefined}
          theme={codeTheme}
        />
      </div>
    );
  }

  if (!data) {
    const emptyValue: JsonContainer = rootType === 'array' ? [] : {};
    return (
      <div
        className={`bg-muted/30 flex min-h-28 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-4 ${className ?? ''}`}
      >
        <BracesIcon className='text-muted-foreground size-5' />
        <Button
          type='button'
          size='sm'
          variant='outline'
          onClick={() => onChange(JSON.stringify(emptyValue, null, 2))}
        >
          {t(
            rootType === 'array'
              ? 'jsonEditor.createArray'
              : 'jsonEditor.createObject',
          )}
        </Button>
      </div>
    );
  }

  return (
    <JsonEditor<JsonContainer>
      className={`workrun-json-editor w-full max-w-none pl-6! ${className ?? ''}`}
      data={data}
      setData={(next) => onChange(JSON.stringify(next, null, 2))}
      rootName={rootName}
      theme={jsonTheme}
      TextEditor={(props) => <CodeEditor {...props} theme={codeTheme} />}
      minWidth='100%'
      maxWidth='none'
      collapse={2}
      allowDrag={false}
      showIconTooltips
      stringTruncateLength={120}
    />
  );
}

export function JsonViewerField({
  value,
  rootName,
  className,
}: Pick<JsonEditorFieldProps, 'value' | 'rootName' | 'className'>) {
  const resolvedTheme = useWorkrunStore((state) => state.resolvedTheme);
  const jsonTheme =
    resolvedTheme === 'dark'
      ? [githubDarkTheme, editorThemeOverrides]
      : [githubLightTheme, editorThemeOverrides];

  let data: JsonContainer | undefined;
  try {
    data = parseJsonContainer(value ?? '');
  } catch {
    return null;
  }

  return data ? (
    <JsonViewer<JsonContainer>
      className={`workrun-json-editor w-full max-w-none pl-6! ${className ?? ''}`}
      data={data}
      rootName={rootName}
      theme={jsonTheme}
      minWidth='100%'
      maxWidth='none'
      collapse={2}
      showIconTooltips
      stringTruncateLength={120}
    />
  ) : null;
}
