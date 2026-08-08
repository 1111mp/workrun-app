import { SchemaExamples } from '@rjsf/core';
import {
  ariaDescribedByIds,
  examplesId,
  getInputProps,
  type BaseInputTemplateProps,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
} from '@rjsf/utils';
import { Input } from '@workspace/ui/components/input';
import type { ChangeEvent, FocusEvent } from 'react';

/** The `BaseInputTemplate` is the template to use to render the basic `<input>` component for the `core` theme.
 * It is used as the template for rendering many of the <input> based widgets that differ by `type` and callbacks only.
 * It can be customized/overridden for other themes or individual implementations as needed.
 *
 * @param props - The `WidgetProps` for this template
 */
export default function BaseInputTemplate<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>({
  id,
  htmlName,
  placeholder,
  required,
  readonly,
  disabled,
  type,
  value,
  onChange,
  onChangeOverride,
  onBlur,
  onFocus,
  autofocus,
  options,
  schema,
  rawErrors = [],
  children,
  extraProps,
  className,
}: BaseInputTemplateProps<T, S, F>) {
  const hasError = rawErrors.length > 0;
  const inputProps = {
    ...extraProps,
    ...getInputProps<T, S, F>(schema, type, options),
  };

  const handleChange = ({
    target: { value: newValue },
  }: ChangeEvent<HTMLInputElement>) =>
    onChange(newValue === '' ? options.emptyValue : newValue);
  const handleBlur = ({ target }: FocusEvent<HTMLInputElement>) =>
    onBlur(id, target?.value);
  const handleFocus = ({ target }: FocusEvent<HTMLInputElement>) =>
    onFocus(id, target?.value);

  return (
    <>
      <Input
        id={id}
        name={htmlName || id}
        type={type}
        placeholder={placeholder}
        autoFocus={autofocus}
        required={required}
        disabled={disabled}
        readOnly={readonly}
        className={className}
        list={schema.examples ? examplesId(id) : undefined}
        {...inputProps}
        value={value || value === 0 ? value : ''}
        onChange={onChangeOverride || handleChange}
        onBlur={handleBlur}
        onFocus={handleFocus}
        aria-invalid={hasError}
        aria-describedby={ariaDescribedByIds(id, !!schema.examples)}
      />
      {children}
      <SchemaExamples id={id} schema={schema} />
    </>
  );
}
