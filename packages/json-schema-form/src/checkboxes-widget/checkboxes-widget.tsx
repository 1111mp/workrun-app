import {
  ariaDescribedByIds,
  enumOptionsDeselectValue,
  enumOptionsIsSelected,
  enumOptionsSelectValue,
  enumOptionValueDecoder,
  getOptionValueFormat,
  optionId,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
  type WidgetProps,
} from '@rjsf/utils';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { Field, FieldGroup, FieldLabel } from '@workspace/ui/components/field';
import { cn } from '@workspace/ui/lib/utils';

/** The `CheckboxesWidget` is a widget for rendering checkbox groups.
 *  It is typically used to represent an array of enums.
 *
 * @param props - The `WidgetProps` for this component
 */
export default function CheckboxesWidget<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>({
  id,
  htmlName,
  disabled,
  options,
  value,
  autofocus,
  readonly,
  required,
  rawErrors = [],
  onChange,
  onBlur,
  onFocus,
  className,
}: WidgetProps<T, S, F>) {
  const { enumOptions, enumDisabled, inline, emptyValue } = options;
  const optionValueFormat = getOptionValueFormat(options);
  const checkboxesValues = Array.isArray(value) ? value : [value];

  const hasError = rawErrors.length > 0;

  return (
    <FieldGroup
      aria-orientation={inline ? 'horizontal' : 'vertical'}
      className={cn({
        'flex flex-col gap-2': !inline,
        'flex flex-row gap-4 flex-wrap': inline,
      })}
    >
      {Array.isArray(enumOptions) &&
        enumOptions.map((option, index) => {
          const checked = enumOptionsIsSelected<S>(
            option.value,
            checkboxesValues,
          );
          const itemDisabled =
            Array.isArray(enumDisabled) && enumDisabled.includes(option.value);
          const indexOptionId = optionId(id, index);
          const key = optionId(id, index);

          return (
            <Field key={key} orientation='horizontal'>
              <Checkbox
                id={indexOptionId}
                name={htmlName || id}
                required={required}
                disabled={disabled || itemDisabled || readonly}
                className={className}
                checked={checked}
                autoFocus={autofocus && index === 0}
                aria-invalid={hasError}
                aria-describedby={ariaDescribedByIds(id)}
                onCheckedChange={(state) => {
                  if (state) {
                    onChange(
                      enumOptionsSelectValue<S>(
                        index,
                        checkboxesValues,
                        enumOptions,
                      ),
                    );
                  } else {
                    onChange(
                      enumOptionsDeselectValue<S>(
                        index,
                        checkboxesValues,
                        enumOptions,
                      ),
                    );
                  }
                }}
                onBlur={() =>
                  onBlur(
                    id,
                    enumOptionValueDecoder<S>(
                      option.value,
                      enumOptions,
                      optionValueFormat,
                      emptyValue,
                    ),
                  )
                }
                onFocus={() =>
                  onFocus(
                    id,
                    enumOptionValueDecoder<S>(
                      option.value,
                      enumOptions,
                      optionValueFormat,
                      emptyValue,
                    ),
                  )
                }
              />
              <FieldLabel className='font-normal' htmlFor={key}>
                {option.label}
              </FieldLabel>
            </Field>
          );
        })}
    </FieldGroup>
  );
}
