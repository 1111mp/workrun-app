// @vitest-environment jsdom

import { customizeValidator } from '@rjsf/validator-ajv8';
import Form from '@workspace/json-schema-form';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

const validator = customizeValidator();

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

describe('JSON Schema select widget', () => {
  it('keeps the enum value in form data while displaying its label', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(Form, {
          schema: {
            type: 'object',
            properties: {
              resolution: {
                type: 'string',
                enum: ['refund', 'escalate'],
              },
            },
          },
          uiSchema: {
            resolution: {
              'ui:enumNames': ['办理退款', '升级给人工客服'],
            },
          },
          formData: { resolution: 'escalate' },
          validator,
        }),
      );
    });

    const input = document.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    );
    expect(input?.value).toBe('升级给人工客服');
  });

  it('returns the enum value after a user selects its label', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    let changedValue: unknown;

    await act(async () => {
      root?.render(
        createElement(Form, {
          schema: {
            type: 'object',
            properties: {
              resolution: {
                type: 'string',
                enum: ['refund', 'escalate'],
              },
            },
          },
          uiSchema: {
            resolution: {
              'ui:enumNames': ['办理退款', '升级给人工客服'],
            },
          },
          validator,
          onChange: (event) => {
            changedValue = event.formData.resolution;
          },
        }),
      );
    });

    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-slot="input-group-button"]',
    );
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((element) => element.textContent?.includes('升级给人工客服'));
    expect(option).toBeDefined();

    await act(async () => {
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(changedValue).toBe('escalate');
    expect(
      document.querySelector<HTMLInputElement>('input[role="combobox"]')?.value,
    ).toBe('升级给人工客服');
  });
});
