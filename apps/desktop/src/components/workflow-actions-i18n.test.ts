import { createInstance } from 'i18next';
import { expect, it } from 'vitest';

import en from '@/locales/en.json';
import zh from '@/locales/zh_CN.json';

it('translates interaction types, instructions and risk levels in both supported languages', async () => {
  const i18n = createInstance();
  await i18n.init({
    resources: { en: { translation: en }, zh_CN: { translation: zh } },
    fallbackLng: false,
  });
  for (const language of ['en', 'zh_CN']) {
    await i18n.changeLanguage(language);
    for (const kind of ['tool', 'question', 'review']) {
      for (const group of ['types', 'hints']) {
        const key = `approval.cards.${group}.${kind}`;
        expect(i18n.exists(key)).toBe(true);
        expect(i18n.t(key)).not.toBe(key);
      }
    }
    for (const risk of ['low', 'medium', 'high', 'unknown']) {
      expect(i18n.exists(`approval.tool.riskLevels.${risk}`)).toBe(true);
    }
  }
  expect(i18n.t('approval.cards.types.tool')).toBe('工具执行授权');
  expect(i18n.t('approval.tool.riskLevels.high')).toBe('高');
});

it('translates output messages and pluralizes tool calls', async () => {
  const i18n = createInstance();
  await i18n.init({
    resources: { en: { translation: en }, zh_CN: { translation: zh } },
    fallbackLng: false,
  });
  expect(Object.keys(en.workflowEditor.output.messages).sort()).toEqual(
    Object.keys(zh.workflowEditor.output.messages).sort(),
  );
  await i18n.changeLanguage('zh_CN');
  expect(i18n.t('workflowEditor.output.messages.answerReceived')).toBe(
    '已收到回答。',
  );
  expect(i18n.t('workflowEditor.output.toolCount', { count: 2 })).toBe(
    '2 次工具调用',
  );
  await i18n.changeLanguage('en');
  expect(i18n.t('workflowEditor.output.toolCount', { count: 1 })).toBe(
    '1 tool call',
  );
  expect(i18n.t('workflowEditor.output.toolCount', { count: 2 })).toBe(
    '2 tool calls',
  );
});
