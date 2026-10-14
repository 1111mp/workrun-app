import { customizeValidator } from '@rjsf/validator-ajv8';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Form from '@workspace/json-schema-form';
import { describe, expect, it } from 'vitest';

const validator = customizeValidator();
const schema = {
  type: 'object' as const,
  properties: {
    resolution: { type: 'string' as const, enum: ['refund', 'escalate'] },
  },
};
const uiSchema = {
  resolution: { 'ui:enumNames': ['办理退款', '升级给人工客服'] },
};

describe('JSON Schema select widget', () => {
  it('keeps the enum value in form data while displaying its label', () => {
    render(
      <Form
        schema={schema}
        uiSchema={uiSchema}
        formData={{ resolution: 'escalate' }}
        validator={validator}
      />,
    );
    expect(screen.getByRole('combobox')).toHaveValue('升级给人工客服');
  });
  it('returns the enum value after a user selects its label', async () => {
    const user = userEvent.setup();
    let changedValue: unknown;
    const { container } = render(
      <Form
        schema={schema}
        uiSchema={uiSchema}
        validator={validator}
        onChange={(event) => {
          changedValue = event.formData.resolution;
        }}
      />,
    );
    // The toggle is an icon-only control; options themselves have accessible roles.
    await user.click(
      container.querySelector<HTMLButtonElement>(
        '[data-slot="input-group-button"]',
      )!,
    );
    await user.click(
      await screen.findByRole('option', { name: '升级给人工客服' }),
    );
    expect(changedValue).toBe('escalate');
    expect(screen.getByRole('combobox')).toHaveValue('升级给人工客服');
  });
});
