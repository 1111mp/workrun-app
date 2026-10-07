// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import {
  deleteRemoteCredential,
  listRemoteCredentials,
  saveRemoteCredential,
  testRemoteConnection,
  type RemoteAuthentication,
} from '@/services/remote-agent';

import { RemoteAgentAuthenticationFields } from './remote-agent-authentication';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/services/remote-agent', () => ({
  listRemoteCredentials: vi.fn(),
  saveRemoteCredential: vi.fn(),
  deleteRemoteCredential: vi.fn(),
  testRemoteConnection: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const credential = {
  id: 'existing',
  name: 'Service key',
  kind: 'bearer' as const,
  origin: 'https://agent.example',
};

async function setup(
  authentication: RemoteAuthentication = {
    type: 'bearer',
    credentialId: 'existing',
  },
  url = 'https://agent.example/a2a',
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(listRemoteCredentials).mockResolvedValue([
    {
      ...credential,
      kind: authentication.type === 'apiKey' ? 'apiKey' : 'bearer',
    },
  ]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const onChange = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RemoteAgentAuthenticationFields, {
          url,
          authentication,
          onChange,
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const click = async (key: string) => {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find(
      (button) => button.textContent === `workflowEditor.remoteAuth.${key}`,
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const input = async (id: string, value: string) => {
    const element = container.querySelector<HTMLInputElement>(`#${id}`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const close = async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  };
  return { container, client, onChange, click, input, close };
}

it('saves a write-only secret and patches only a credential reference into the workflow', async () => {
  const saved = { ...credential, id: 'new', name: 'New service' };
  vi.mocked(saveRemoteCredential).mockResolvedValue(saved);
  const ui = await setup();
  try {
    await ui.click('add');
    expect(
      ui.container.querySelector<HTMLInputElement>('#remote-credential-secret')
        ?.type,
    ).toBe('password');
    await ui.input('remote-credential-name', 'New service');
    await ui.input('remote-credential-secret', 'private-test-key');
    await ui.click('save');
    expect(saveRemoteCredential).toHaveBeenCalledWith({
      id: undefined,
      name: 'New service',
      kind: 'bearer',
      serviceUrl: 'https://agent.example/a2a',
      secret: 'private-test-key',
    });
    expect(ui.onChange).toHaveBeenCalledWith({
      type: 'bearer',
      credentialId: 'new',
    });
    expect(JSON.stringify(ui.onChange.mock.calls)).not.toContain(
      'private-test-key',
    );
    expect(
      JSON.stringify(ui.client.getQueryData(['remote-agent-credentials'])),
    ).not.toContain('private-test-key');
    expect(ui.container.querySelector('#remote-credential-secret')).toBeNull();
  } finally {
    await ui.close();
  }
});

it('edits metadata without reading or replacing the saved secret and can remove the reference', async () => {
  vi.mocked(saveRemoteCredential).mockResolvedValue(credential);
  vi.mocked(deleteRemoteCredential).mockResolvedValue(undefined);
  const ui = await setup();
  try {
    await ui.click('edit');
    expect(
      ui.container.querySelector<HTMLInputElement>('#remote-credential-secret')
        ?.value,
    ).toBe('');
    await ui.click('save');
    expect(saveRemoteCredential).toHaveBeenCalledWith({
      id: 'existing',
      name: 'Service key',
      kind: 'bearer',
      serviceUrl: 'https://agent.example/a2a',
      secret: undefined,
    });
    await ui.click('edit');
    await ui.click('delete');
    expect(deleteRemoteCredential).toHaveBeenCalledWith('existing');
    expect(ui.onChange).toHaveBeenLastCalledWith({
      type: 'bearer',
      credentialId: '',
    });
  } finally {
    await ui.close();
  }
});

it('connection testing passes only the URL and credential reference and surfaces authentication failures', async () => {
  vi.mocked(testRemoteConnection).mockRejectedValue(
    'A2A HTTP request failed with status 401 Unauthorized',
  );
  const ui = await setup();
  try {
    await ui.click('test');
    expect(testRemoteConnection).toHaveBeenCalledWith(
      'https://agent.example/a2a',
      { type: 'bearer', credentialId: 'existing' },
    );
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain(
      '401',
    );
  } finally {
    await ui.close();
  }
});

it.each<[RemoteAuthentication, string]>([
  [{ type: 'none' }, 'workflowEditor.remoteAuth.none'],
  [{ type: 'bearer', credentialId: 'existing' }, 'Bearer Token'],
  [
    { type: 'apiKey', credentialId: 'existing', headerName: 'X-API-Key' },
    'API Key',
  ],
])(
  'shows selected labels before opening either popup (%s)',
  async (authentication, label) => {
    const ui = await setup(authentication);
    try {
      const mode = ui.container.querySelector(
        '[aria-label="workflowEditor.remoteAuth.mode"] [data-slot="select-value"]',
      );
      expect(mode?.textContent).toBe(label);
      if (authentication.type !== 'none') {
        const selected = ui.container.querySelector(
          '[aria-label="workflowEditor.remoteAuth.credential"] [data-slot="select-value"]',
        );
        expect(selected?.textContent).toBe('Service key');
        expect(selected?.textContent).not.toBe('existing');
      }
    } finally {
      await ui.close();
    }
  },
);

it.each([
  ['https://agent.example/another-path', true, null],
  ['https://other.example', false, 'originMismatch'],
  ['', false, 'enterUrl'],
] as const)(
  'keeps saved credentials visible and explains availability for %s',
  async (url, enabled, explanation) => {
    const ui = await setup({ type: 'bearer', credentialId: '' }, url);
    try {
      if (explanation)
        expect(ui.container.textContent).toContain(
          `workflowEditor.remoteAuth.${explanation}`,
        );
      const trigger = ui.container.querySelector<HTMLButtonElement>(
        '[aria-label="workflowEditor.remoteAuth.credential"]',
      )!;
      await act(async () => {
        trigger.click();
      });
      const option = [
        ...document.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find((item) => item.textContent?.includes('Service key'));
      expect(option).toBeDefined();
      expect(option?.getAttribute('aria-disabled') === 'true').toBe(!enabled);
      if (enabled) {
        await act(async () => {
          option!.click();
        });
        expect(ui.onChange).toHaveBeenCalledWith({
          type: 'bearer',
          credentialId: 'existing',
        });
      } else {
        expect(option?.textContent).toContain('https://agent.example');
        await act(async () => {
          option!.click();
        });
        expect(ui.onChange).not.toHaveBeenCalled();
      }
    } finally {
      await ui.close();
    }
  },
);

it('reloads the saved credential when configuring a node again', async () => {
  const first = await setup();
  await first.close();
  const next = await setup({ type: 'bearer', credentialId: '' });
  try {
    expect(listRemoteCredentials).toHaveBeenCalledTimes(2);
    const trigger = next.container.querySelector<HTMLButtonElement>(
      '[aria-label="workflowEditor.remoteAuth.credential"]',
    )!;
    await act(async () => {
      trigger.click();
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent === 'Service key');
    expect(option).toBeDefined();
    await act(async () => {
      option!.click();
    });
    expect(next.onChange).toHaveBeenCalledWith({
      type: 'bearer',
      credentialId: 'existing',
    });
  } finally {
    await next.close();
  }
});
