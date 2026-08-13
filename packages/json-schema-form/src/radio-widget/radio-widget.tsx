import {
  ariaDescribedByIds,
  enumOptionsIsSelected,
  enumOptionValueDecoder,
  enumOptionValueEncoder,
  getOptionValueFormat,
  optionId,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
  type WidgetProps,
} from '@rjsf/utils';
import { Label } from '@workspace/ui/components/label';
import {
  RadioGroup,
  RadioGroupItem,
} from '@workspace/ui/components/radio-group';
import { cn } from '@workspace/ui/lib/utils';

/** The `RadioWidget` is a widget for rendering a radio group.
 *  It is typically used with a string property constrained with enum options.
 *
 * @param props - The `WidgetProps` for this component
 */
export default function RadioWidget<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>({
  id,
  options,
  value,
  required,
  disabled,
  readonly,
  rawErrors = [],
  onChange,
  onBlur,
  onFocus,
  className,
}: WidgetProps<T, S, F>) {
  const { enumOptions, enumDisabled, emptyValue } = options;
  const optionValueFormat = getOptionValueFormat(options);

  const handleChange = (enumValue: string) =>
    onChange(
      enumOptionValueDecoder<S>(
        enumValue,
        enumOptions,
        optionValueFormat,
        emptyValue,
      ),
    );
  const handleBlur = () =>
    onBlur(
      id,
      enumOptionValueDecoder<S>(
        value,
        enumOptions,
        optionValueFormat,
        emptyValue,
      ),
    );
  const handleFocus = () =>
    onFocus(
      id,
      enumOptionValueDecoder<S>(
        value,
        enumOptions,
        optionValueFormat,
        emptyValue,
      ),
    );

  const inline = Boolean(options?.inline);
  const hasError = rawErrors.length > 0;

  return (
    <RadioGroup
      defaultValue={value?.toString()}
      required={required}
      disabled={disabled || readonly}
      orientation={inline ? 'horizontal' : 'vertical'}
      aria-describedby={ariaDescribedByIds(id)}
      className={cn('flex flex-wrap', { 'flex-col': !inline }, className)}
      onValueChange={(e: string) => {
        handleChange(e);
      }}
      onBlur={handleBlur}
      onFocus={handleFocus}
    >
      {Array.isArray(enumOptions) &&
        enumOptions.map((option, index) => {
          const itemDisabled =
            Array.isArray(enumDisabled) && enumDisabled.includes(option.value);
          const checked = enumOptionsIsSelected<S>(option.value, value);
          const key = optionId(id, index);

          return (
            <div key={key} className='flex items-center gap-2'>
              <RadioGroupItem
                id={key}
                aria-invalid={hasError}
                data-checked={checked}
                disabled={itemDisabled}
                value={enumOptionValueEncoder(
                  option.value,
                  index,
                  optionValueFormat,
                )}
              />
              <Label className='leading-tight' htmlFor={key}>
                {option.label}
              </Label>
            </div>
          );
        })}
    </RadioGroup>
  );
}
