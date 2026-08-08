import {
  getUiOptions,
  type FieldTemplateProps,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
} from '@rjsf/utils';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@workspace/ui/components/field';

/** The `FieldTemplate` component is the template used by `SchemaField` to render any field. It renders the field
 * content, (label, description, children, errors and help) inside a `WrapIfAdditional` component.
 *
 * @param props - The `FieldTemplateProps` for this component
 */
export default function FieldTemplate<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>({
  id,
  children,
  displayLabel,
  rawErrors = [],
  // errors,
  help,
  description,
  rawDescription,
  classNames,
  style,
  disabled,
  label,
  hidden,
  onKeyRename,
  onKeyRenameBlur,
  onRemoveProperty,
  readonly,
  required,
  schema,
  uiSchema,
  registry,
}: FieldTemplateProps<T, S, F>) {
  const hasError = rawErrors.length > 0;
  const uiOptions = getUiOptions(uiSchema);
  const isCheckbox = uiOptions.widget === 'checkbox';

  if (hidden) {
    return <Field aria-invalid={hasError}>{children}</Field>;
  }

  return (
    <Field aria-invalid={hasError}>
      {displayLabel && !isCheckbox && (
        <FieldLabel htmlFor={id}>
          {label}
          {required && <span className='text-destructive'>*</span>}
        </FieldLabel>
      )}
      {children}
      {rawDescription && !isCheckbox && (
        <FieldDescription>{rawDescription}</FieldDescription>
      )}
      {hasError && (
        <FieldError errors={rawErrors.map((message) => ({ message }))} />
      )}
      {help}
    </Field>
  );
}
