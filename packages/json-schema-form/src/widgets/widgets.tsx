import type {
  FormContextType,
  RegistryWidgetsType,
  RJSFSchema,
  StrictRJSFSchema,
} from '@rjsf/utils';

import CheckboxWidget from '../checkbox-widget';
import CheckboxesWidget from '../checkboxes-widget';
import RadioWidget from '../radio-widget';
import RangeWidget from '../range-widget';
import SelectWidget from '../select-widget';
import TextareaWidget from '../textarea-widget';

export function generateWidgets<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>(): RegistryWidgetsType<T, S, F> {
  return {
    CheckboxWidget,
    CheckboxesWidget,
    RadioWidget,
    RangeWidget,
    SelectWidget,
    TextareaWidget,
  };
}

export default generateWidgets();
