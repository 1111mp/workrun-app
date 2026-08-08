import {
  ariaDescribedByIds,
  enumOptionValueDecoder,
  enumOptionValueEncoder,
  getOptionValueFormat,
  getUiOptions,
  logUnsupportedDefaultForEnum,
  SelectedOptionDescription,
  type FormContextType,
  type RJSFSchema,
  type StrictRJSFSchema,
  type WidgetProps,
} from '@rjsf/utils';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from '@workspace/ui/components/combobox';
import { FieldContent } from '@workspace/ui/components/field';

/** The `SelectWidget` is a widget for rendering dropdowns.
 *  It is typically used with string properties constrained with enum options.
 *
 * @param props - The `WidgetProps` for this component
 */
export default function SelectWidget<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>({
  id,
  options,
  required,
  disabled,
  readonly,
  value,
  schema,
  multiple,
  autofocus,
  onChange,
  onBlur,
  onFocus,
  placeholder,
  rawErrors = [],
  className,
  registry,
  uiSchema,
}: WidgetProps<T, S, F>) {
  const { enumOptions, enumDisabled, emptyValue: optEmptyValue } = options;
  const uiOptions = getUiOptions(uiSchema);

  const { formContext } = registry;
  const optionValueFormat = getOptionValueFormat({
    options,
    ...formContext?.globalOptions,
  });

  logUnsupportedDefaultForEnum<S>(id, schema, enumOptions, multiple);

  const handleFocus = () => {
    onFocus(
      id,
      enumOptionValueDecoder<S>(
        value,
        enumOptions,
        optionValueFormat,
        optEmptyValue,
      ),
    );
  };

  const handleBlur = () => {
    onBlur(
      id,
      enumOptionValueDecoder<S>(
        value,
        enumOptions,
        optionValueFormat,
        optEmptyValue,
      ),
    );
  };

  const items = (enumOptions as any)?.map(
    ({ value: enumValue, label: enumLabel }: any, index: number) => ({
      value: multiple
        ? enumValue
        : enumOptionValueEncoder(enumValue, index, optionValueFormat),
      label: enumLabel,
      index,
      disabled: Array.isArray(enumDisabled) && enumDisabled.includes(enumValue),
    }),
  );

  const hasError = rawErrors.length > 0;

  return (
    <FieldContent>
      <Combobox
        autoHighlight
        multiple={multiple}
        items={items}
        // itemToStringValue={(item: (typeof items)[number]) => item.label}
        disabled={disabled || readonly}
        required={required}
        value={value ?? ''}
        onValueChange={(values) => {
          onChange(
            enumOptionValueDecoder(
              multiple ? values.map(String) : values,
              enumOptions,
              optionValueFormat,
              optEmptyValue,
            ),
          );
        }}
      >
        {multiple ? (
          <ComboboxChips>
            <ComboboxValue>
              {(value as string[]).map((item) => (
                <ComboboxChip key={item}>{item}</ComboboxChip>
              ))}
            </ComboboxValue>
            <ComboboxChipsInput
              id={`combobox-input-${id}`}
              aria-describedby={ariaDescribedByIds(id)}
              aria-invalid={hasError}
              autoFocus={autofocus}
              className={className}
              placeholder={uiOptions.placeholder ?? placeholder}
              onFocus={handleFocus}
              onBlur={handleBlur}
            />
          </ComboboxChips>
        ) : (
          <ComboboxInput
            showClear
            id={`combobox-input-${id}`}
            aria-describedby={ariaDescribedByIds(id)}
            aria-invalid={hasError}
            autoFocus={autofocus}
            className={className}
            placeholder={uiOptions.placeholder ?? placeholder}
            onFocus={handleFocus}
            onBlur={handleBlur}
          />
        )}
        <ComboboxContent>
          <ComboboxEmpty>No items found.</ComboboxEmpty>
          <ComboboxList>
            {(item) => (
              <ComboboxItem key={item.value} value={String(item.value)}>
                {item.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <SelectedOptionDescription
        id={id}
        multiple={multiple}
        options={options}
        registry={registry}
        uiSchema={uiSchema}
        value={value}
      />
    </FieldContent>
  );
}
