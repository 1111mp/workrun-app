import {
  labelValue,
  schemaRequiresTrueValue,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
  type WidgetProps,
} from '@rjsf/utils';
import { Checkbox } from '@workspace/ui/components/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '@workspace/ui/components/field';

/** The `CheckBoxWidget` is a widget for rendering boolean properties.
 *  It is typically used to represent a boolean.
 *
 * @param props - The `WidgetProps` for this component
 */
export default function CheckBoxWidget<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>(props: WidgetProps<T, S, F>) {
  const {
    id,
    htmlName,
    value,
    disabled,
    readonly,
    label,
    hideLabel,
    schema,
    autofocus,
    options,
    onChange,
    onBlur,
    onFocus,
    className,
    rawErrors = [],
  } = props;

  const hasError = rawErrors.length > 0;
  // Because an unchecked checkbox will cause html5 validation to fail, only add
  // the "required" attribute if the field value must be "true", due to the
  // "const" or "enum" keywords
  const required = schemaRequiresTrueValue<S>(schema);

  const handleChange = (checked: boolean) => onChange(checked);
  const handleBlur = () => onBlur(id, value);
  const handleFocus = () => onFocus(id, value);

  const description = options.description || schema.description;

  return (
    <Field
      orientation='horizontal'
      aria-invalid={hasError}
      aria-disabled={disabled || readonly || undefined}
    >
      <Checkbox
        id={id}
        name={htmlName || id}
        aria-invalid={hasError}
        checked={typeof value === 'undefined' ? false : Boolean(value)}
        required={required}
        disabled={disabled || readonly}
        autoFocus={autofocus}
        onCheckedChange={handleChange}
        onBlur={handleBlur}
        onFocus={handleFocus}
        className={className}
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>
          {labelValue(label, hideLabel || !label)}
        </FieldLabel>
        {!hideLabel && description && (
          <FieldDescription>{description}</FieldDescription>
        )}
      </FieldContent>
    </Field>
  );
}
