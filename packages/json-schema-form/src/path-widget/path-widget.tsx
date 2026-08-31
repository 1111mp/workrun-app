import {
  ariaDescribedByIds,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
  type WidgetProps,
} from '@rjsf/utils';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';

export type PathPicker = (options: { directory: boolean }) => Promise<string | null>;

type PathPickerFormContext = {
  selectPath?: PathPicker;
};

/** Renders a native file or directory picker backed by `formContext.selectPath`. */
export default function PathWidget<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>({
  id,
  htmlName,
  value,
  disabled,
  readonly,
  autofocus,
  onChange,
  onBlur,
  onFocus,
  options,
  rawErrors = [],
  registry,
  placeholder,
  className,
}: WidgetProps<T, S, F>) {
  const selectPath = (registry.formContext as PathPickerFormContext).selectPath;
  const directory = options.directory === true;
  const buttonLabel =
    typeof options.buttonLabel === 'string'
      ? options.buttonLabel
      : directory
        ? 'Choose directory'
        : 'Choose file';
  const select = async () => {
    if (!selectPath || disabled || readonly) return;
    const path = await selectPath({ directory });
    if (path !== null) onChange(path);
  };

  return (
    <div className='flex items-center gap-2'>
      <Input
        id={id}
        name={htmlName || id}
        value={typeof value === 'string' ? value : ''}
        placeholder={placeholder}
        autoFocus={autofocus}
        readOnly
        disabled={disabled}
        className={className}
        aria-invalid={rawErrors.length > 0}
        aria-describedby={ariaDescribedByIds(id)}
        onBlur={({ target }) => onBlur(id, target.value)}
        onFocus={({ target }) => onFocus(id, target.value)}
      />
      <Button
        type='button'
        variant='outline'
        disabled={disabled || readonly || !selectPath}
        onClick={() => void select()}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}
