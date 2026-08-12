import {
  getTemplate,
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
  description: _description,
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

  const WrapIfAdditionalTemplate = getTemplate<
    'WrapIfAdditionalTemplate',
    T,
    S,
    F
  >('WrapIfAdditionalTemplate', registry, uiOptions);

  if (hidden) {
    return <Field data-invalid={hasError}>{children}</Field>;
  }

  const isCheckbox = uiOptions.widget === 'checkbox';

  return (
    <WrapIfAdditionalTemplate
      classNames={classNames}
      style={style}
      disabled={disabled}
      id={id}
      label={label}
      displayLabel={displayLabel}
      onKeyRename={onKeyRename}
      onKeyRenameBlur={onKeyRenameBlur}
      onRemoveProperty={onRemoveProperty}
      rawDescription={rawDescription}
      readonly={readonly}
      required={required}
      schema={schema}
      uiSchema={uiSchema}
      registry={registry}
    >
      <Field data-invalid={hasError}>
        {displayLabel && !isCheckbox && (
          <FieldLabel htmlFor={id}>
            {label}
            {required && <span className='text-destructive'>*</span>}
          </FieldLabel>
        )}
        {children}
        {displayLabel && rawDescription && !isCheckbox && (
          <FieldDescription>{rawDescription}</FieldDescription>
        )}
        {hasError && (
          <FieldError errors={rawErrors.map((message) => ({ message }))} />
        )}
        {help}
      </Field>
    </WrapIfAdditionalTemplate>
  );
}
