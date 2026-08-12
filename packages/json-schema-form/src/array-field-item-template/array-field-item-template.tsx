import {
  getTemplate,
  getUiOptions,
  type ArrayFieldItemTemplateProps,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
} from '@rjsf/utils';
import { Field, FieldContent } from '@workspace/ui/components/field';

/** The `ArrayFieldItemTemplate` component is the template used to render an items of an array.
 *
 * @param props - The `ArrayFieldItemTemplateProps` props for the component
 */
export default function ArrayFieldItemTemplate<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>(props: ArrayFieldItemTemplateProps<T, S, F>) {
  const {
    children,
    buttonsProps,
    displayLabel,
    hasDescription,
    hasToolbar,
    uiSchema,
    registry,
  } = props;
  const uiOptions = getUiOptions<T, S, F>(uiSchema);
  const ArrayFieldItemButtonsTemplate = getTemplate<
    'ArrayFieldItemButtonsTemplate',
    T,
    S,
    F
  >('ArrayFieldItemButtonsTemplate', registry, uiOptions);
  const margin = hasDescription ? -6 : 22;

  return (
    <Field orientation='horizontal'>
      <FieldContent>{children}</FieldContent>
      <div className='flex items-end justify-end p-0.5'>
        {hasToolbar && (
          <div
            className='flex gap-2'
            style={{
              marginLeft: '5px',
              marginTop: displayLabel ? `${margin}px` : undefined,
            }}
          >
            <ArrayFieldItemButtonsTemplate {...buttonsProps} />
          </div>
        )}
      </div>
    </Field>
  );
}
