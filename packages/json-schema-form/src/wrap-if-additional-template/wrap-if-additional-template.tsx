import {
  ADDITIONAL_PROPERTY_FLAG,
  buttonId,
  TranslatableString,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
  type WrapIfAdditionalTemplateProps,
} from '@rjsf/utils';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';

/** The `WrapIfAdditional` component is used by the `FieldTemplate` to rename, or remove properties that are
 * part of an `additionalProperties` part of a schema.
 *
 * @param props - The `WrapIfAdditionalProps` for this component
 */
export default function WrapIfAdditionalTemplate<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>({
  classNames,
  style,
  children,
  disabled,
  id,
  label,
  displayLabel,
  rawDescription,
  readonly,
  required,
  schema,
  uiSchema,
  registry,
  rawErrors = [],
  onRemoveProperty,
  onKeyRenameBlur,
}: WrapIfAdditionalTemplateProps<T, S, F>) {
  const { templates, translateString } = registry;
  // Button templates are not overridden in the uiSchema
  const { RemoveButton } = templates.ButtonTemplates;
  const keyLabel = translateString(TranslatableString.KeyLabel, [label]);

  const additional = ADDITIONAL_PROPERTY_FLAG in schema;
  if (!additional) {
    return (
      <div className={classNames} style={style}>
        {children}
      </div>
    );
  }

  const keyId = `${id}-key`;
  const hasError = rawErrors.length > 0;

  return (
    <Field orientation='horizontal'>
      <FieldGroup>
        <FieldContent>
          {displayLabel && (
            <FieldLabel
              htmlFor={keyId}
              className='text-muted-foreground text-sm leading-none font-medium'
            >
              {keyLabel}
            </FieldLabel>
          )}
          <Input
            id={keyId}
            key={label}
            name={keyId}
            type='text'
            required={required}
            defaultValue={label}
            aria-invalid={hasError}
            disabled={disabled || readonly}
            className='w-full border shadow-sm'
            onBlur={!readonly ? onKeyRenameBlur : undefined}
          />
          {!!rawDescription && (
            <FieldDescription>{rawDescription}</FieldDescription>
          )}
        </FieldContent>
        <FieldContent>{children}</FieldContent>
      </FieldGroup>
      <RemoveButton
        id={buttonId(id, 'remove')}
        iconType='block'
        uiSchema={uiSchema}
        registry={registry}
        disabled={disabled || readonly}
        className='rjsf-object-property-remove w-full'
        onClick={onRemoveProperty}
      />
    </Field>
  );
}
