import type {
  FormContextType,
  RJSFSchema,
  StrictRJSFSchema,
  TemplatesType,
} from '@rjsf/utils';

import AddButton from '../add-button';
import ArrayFieldItemTemplate from '../array-field-item-template';
import ArrayFieldTemplate from '../array-field-template';
import BaseInputTemplate from '../base-input-template';
import DescriptionFieldTemplate from '../description-field-template';
import ErrorListTemplate from '../error-list-template';
import FieldHelpTemplate from '../field-help-template';
import FieldTemplate from '../field-template';
import GridTemplate from '../grid-template';
import {
  ClearButton,
  CopyButton,
  MoveDownButton,
  MoveUpButton,
  RemoveButton,
} from '../icon-button';
import MultiSchemaFieldTemplate from '../multi-schema-field-template';
import ObjectFieldTemplate from '../object-field-template';
import OptionalDataControlsTemplate from '../optional-data-controls-template';
import SubmitButton from '../submit-button';
import TitleFieldTemplate from '../title-field-template';
import WrapIfAdditionalTemplate from '../wrap-if-additional-template';

export function generateTemplates<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>(): Partial<TemplatesType<T, S, F>> {
  return {
    ArrayFieldItemTemplate,
    ArrayFieldTemplate,
    BaseInputTemplate,
    ButtonTemplates: {
      AddButton,
      CopyButton,
      MoveDownButton,
      MoveUpButton,
      RemoveButton,
      SubmitButton,
      ClearButton,
    },
    DescriptionFieldTemplate,
    ErrorListTemplate,
    FieldHelpTemplate,
    FieldTemplate,
    GridTemplate,
    MultiSchemaFieldTemplate,
    ObjectFieldTemplate,
    OptionalDataControlsTemplate,
    TitleFieldTemplate,
    WrapIfAdditionalTemplate,
  };
}

export default generateTemplates();
