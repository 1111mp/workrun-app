import {
  ariaDescribedByIds,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
  type WidgetProps,
} from '@rjsf/utils';
import { Textarea } from '@workspace/ui/components/textarea';

type CustomWidgetProps<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
> = WidgetProps<T, S, F> & {
  options: any;
};

/** The `TextareaWidget` is a widget for rendering input fields as textarea.
 *
 * @param props - The `WidgetProps` for this component
 */
export default function TextareaWidget<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>({
  id,
  htmlName,
  placeholder,
  value,
  required,
  disabled,
  autofocus,
  readonly,
  rawErrors = [],
  onBlur,
  onFocus,
  onChange,
  options,
  className,
}: CustomWidgetProps<T, S, F>) {
  const handleChange = ({
    target: { value: newValue },
  }: React.ChangeEvent<HTMLTextAreaElement>) =>
    onChange(newValue === '' ? options.emptyValue : newValue);
  const handleBlur = ({ target }: React.FocusEvent<HTMLTextAreaElement>) =>
    onBlur(id, target?.value);
  const handleFocus = ({ target }: React.FocusEvent<HTMLTextAreaElement>) =>
    onFocus(id, target?.value);

  const hasError = rawErrors.length > 0;

  return (
    <Textarea
      id={id}
      name={htmlName || id}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readonly}
      value={value ?? ''}
      required={required}
      autoFocus={autofocus}
      rows={options.rows || 5}
      aria-invalid={hasError}
      aria-describedby={ariaDescribedByIds(id)}
      className={className}
      onChange={handleChange}
      onBlur={handleBlur}
      onFocus={handleFocus}
    />
  );
}
