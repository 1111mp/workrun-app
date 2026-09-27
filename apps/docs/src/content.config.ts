import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { pageThemeObsidianSchema } from 'starlight-theme-obsidian/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    // Enables Obsidian theme frontmatter while retaining Starlight validation.
    schema: docsSchema({ extend: pageThemeObsidianSchema }),
  }),
  i18n: defineCollection({
    loader: glob({ base: './src/content/i18n', pattern: '**/*.json' }),
    schema: i18nSchema(),
  }),
};
