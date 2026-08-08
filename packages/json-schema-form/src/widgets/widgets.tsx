import type {
  FormContextType,
  RegistryWidgetsType,
  RJSFSchema,
  StrictRJSFSchema,
} from '@rjsf/utils';

import CheckboxWidget from '../checkbox-widget';
import SelectWidget from '../select-widget';

export function generateWidgets<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>(): RegistryWidgetsType<T, S, F> {
  return {
    CheckboxWidget,
    SelectWidget,
  };
}

export default generateWidgets();
