import starlight from '@astrojs/starlight';
// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // Used for canonical URLs and the generated sitemap until a custom domain is attached.
  site: 'https://workrun-docs.pages.dev',
  integrations: [
    starlight({
      title: {
        'zh-CN': 'Workrun 文档',
        en: 'Workrun Docs',
      },
      description: 'A local-first workspace for AI automation.',
      locales: {
        root: { label: 'English', lang: 'en' },
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
      },
      defaultLocale: 'root',
      social: [
        {
          icon: 'github',
          label: 'Workrun on GitHub',
          href: 'https://github.com/1111mp/workrun-app',
        },
      ],
      customCss: [
        'starlight-theme-obsidian/styles/layers.css',
        'starlight-theme-obsidian/styles/theme.css',
        'starlight-theme-obsidian/styles/centered-reading.css',
        'starlight-theme-obsidian/styles/common.css',
        './src/styles/custom.css',
      ],
      // The package's Graph integration is currently incompatible with Astro 7.
      // Use its visual components directly until the upstream plugin is fixed.
      components: {
        Sidebar: 'starlight-theme-obsidian/overrides/Sidebar.astro',
        PageFrame: 'starlight-theme-obsidian/overrides/PageFrame.astro',
        Pagination: 'starlight-theme-obsidian/overrides/Pagination.astro',
      },
      editLink: {
        baseUrl:
          'https://github.com/1111mp/workrun-app/edit/main/apps/docs/src/content/docs/',
      },
      sidebar: [
        {
          label: 'Get started',
          translations: { 'zh-CN': '开始使用' },
          items: [
            {
              label: '5-minute quickstart',
              translations: { 'zh-CN': '5 分钟快速开始' },
              link: '/getting-started/quickstart/',
            },
            {
              label: 'Installation and prerequisites',
              translations: { 'zh-CN': '安装与前置条件' },
              link: '/getting-started/installation/',
            },
            {
              label: 'Configure model profiles',
              translations: { 'zh-CN': '配置模型 Profile' },
              link: '/getting-started/model-profiles/',
            },
          ],
        },
        {
          label: 'Core concepts',
          translations: { 'zh-CN': '核心概念' },
          items: [
            {
              label: 'How Workrun works',
              translations: { 'zh-CN': 'Workrun 的工作方式' },
              link: '/concepts/overview/',
            },
            {
              label: 'Workflows and state',
              translations: { 'zh-CN': '工作流与状态' },
              link: '/concepts/workflows-and-state/',
            },
            {
              label: 'Apps, tools, and MCP',
              translations: { 'zh-CN': 'App、工具与 MCP' },
              link: '/concepts/apps-tools-and-mcp/',
            },
          ],
        },
        {
          label: 'Build automation',
          translations: { 'zh-CN': '构建自动化' },
          items: [
            {
              label: 'Build your first workflow',
              translations: { 'zh-CN': '构建第一个工作流' },
              link: '/guides/build-a-workflow/',
            },
            {
              label: 'Use Python Apps',
              translations: { 'zh-CN': '使用 Python App' },
              link: '/guides/python-apps/',
            },
            {
              label: 'Connect an MCP server',
              translations: { 'zh-CN': '连接 MCP Server' },
              link: '/guides/connect-an-mcp-server/',
            },
            {
              label: 'Human review and resume',
              translations: { 'zh-CN': '人工审批与恢复' },
              link: '/guides/human-in-the-loop/',
            },
          ],
        },
        {
          label: 'Runs and quality',
          translations: { 'zh-CN': '运行与质量' },
          items: [
            {
              label: 'Runs, debugging, and traces',
              translations: { 'zh-CN': '运行、调试与追踪' },
              link: '/quality/runs-and-traces/',
            },
            {
              label: 'Evaluations and quality gates',
              translations: { 'zh-CN': '评估与质量门' },
              link: '/quality/evaluations/',
            },
          ],
        },
        {
          label: 'Team and publishing',
          translations: { 'zh-CN': '团队与发布' },
          items: [
            {
              label: 'Versioned publishing',
              translations: { 'zh-CN': '版本化发布' },
              link: '/team/publishing/',
            },
          ],
        },
      ],
    }),
  ],
});
