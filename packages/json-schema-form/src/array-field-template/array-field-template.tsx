import {
  buttonId,
  getTemplate,
  getUiOptions,
  type ArrayFieldTemplateProps,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
} from '@rjsf/utils';
import { FieldGroup, FieldSet } from '@workspace/ui/components/field';

/** The `ArrayFieldTemplate` component is the template used to render all items in an array.
 *
 * @param props - The `ArrayFieldTemplateProps` props for the component
 */
export default function ArrayFieldTemplate<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>(props: ArrayFieldTemplateProps<T, S, F>) {
  const {
    canAdd,
    disabled,
    fieldPathId,
    uiSchema,
    items,
    optionalDataControl,
    onAddClick,
    readonly,
    registry,
    required,
    schema,
    title,
  } = props;
  const uiOptions = getUiOptions<T, S, F>(uiSchema);
  const ArrayFieldDescriptionTemplate = getTemplate<
    'ArrayFieldDescriptionTemplate',
    T,
    S,
    F
  >('ArrayFieldDescriptionTemplate', registry, uiOptions);
  const ArrayFieldTitleTemplate = getTemplate<
    'ArrayFieldTitleTemplate',
    T,
    S,
    F
  >('ArrayFieldTitleTemplate', registry, uiOptions);
  const showOptionalDataControlInTitle = !readonly && !disabled;
  // Button templates are not overridden in the uiSchema
  const {
    ButtonTemplates: { AddButton },
  } = registry.templates;

  return (
    <FieldSet>
      <ArrayFieldTitleTemplate
        fieldPathId={fieldPathId}
        title={uiOptions.title || title}
        schema={schema}
        uiSchema={uiSchema}
        required={required}
        registry={registry}
        optionalDataControl={
          showOptionalDataControlInTitle ? optionalDataControl : undefined
        }
      />
      <ArrayFieldDescriptionTemplate
        fieldPathId={fieldPathId}
        description={uiOptions.description || schema.description}
        schema={schema}
        uiSchema={uiSchema}
        registry={registry}
      />
      <FieldGroup>
        {!showOptionalDataControlInTitle ? optionalDataControl : undefined}
        {items}
        {canAdd && (
          <div className='mt-2 flex justify-end'>
            <AddButton
              id={buttonId(fieldPathId, 'add')}
              className='rjsf-array-item-add'
              onClick={onAddClick}
              disabled={disabled || readonly}
              uiSchema={uiSchema}
              registry={registry}
            />
          </div>
        )}
      </FieldGroup>
    </FieldSet>
  );
}
