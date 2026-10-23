# Workrun documentation

The official documentation uses Astro and Starlight. English pages live in
`src/content/docs/`; Simplified Chinese pages mirror them under `zh-cn/`.

## Develop and build

Run these commands from the repository root:

```sh
pnpm docs:dev
pnpm docs:build
```

The static site is generated in `apps/docs/dist/`, including the Pagefind search
index and sitemap. Building locally does not deploy the website.

## Conversational workflow documentation

- English: [Build workflows through conversation](src/content/docs/guides/conversational-workflows.md)
- 简体中文：[通过对话编排工作流](src/content/docs/zh-cn/guides/conversational-workflows.md)
- Implementation and test boundaries: [Assistant README](../desktop/src-tauri/src/module/assistant/README.md)

Keep both languages, homepage entry points, quickstart, model setup, and the
`astro.config.mjs` sidebar aligned. Document plan approval, execution confirmation,
and direct-tool confirmation as separate interactions. Workflow Chat mode is a
separate feature from the start-page assistant.
