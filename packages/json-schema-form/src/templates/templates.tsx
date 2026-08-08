import type {
  FormContextType,
  RJSFSchema,
  StrictRJSFSchema,
  TemplatesType,
} from '@rjsf/utils';

import BaseInputTemplate from '../base-input-template';
import ErrorListTemplate from '../error-list-template';
import FieldTemplate from '../field-template';

export function generateTemplates<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>(): Partial<TemplatesType<T, S, F>> {
  return {
    BaseInputTemplate,
    ErrorListTemplate,
    FieldTemplate,
  };
}

export default generateTemplates();
