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

## Documentation review checklist

- Keep each English content page paired with `zh-cn/`, with equivalent examples,
  limitations, screenshots, and sidebar entries. Internal Chinese links should
  stay under `/zh-cn/`.
- Verify local links, media paths, and heading fragments against the generated
  HTML in `dist/`; a successful build alone does not catch broken anchors.
- Check Python snippets against `packages/python-sdk/src/workrun_sdk/` and JSON
  examples against the fields defined earlier in their tutorial.
- Check behavior against the desktop implementation: a new workflow starts with
  Start only; visible global state is shared, while private node output needs a
  reader grant from its producer.
- Evaluation Tool App and MCP calls require exact tool-and-argument fixtures.
  Unmatched calls fail without executing the real tool. Process, CodeAct Agent,
  and Remote Agent nodes remain unsupported in evaluations.
- Distinguish pending-action continuation, interrupted-run recovery, and **Run
  again**. Failed or stopped tasks require a new run.
- Run `pnpm docs:build` and `git diff --check` after changes. Review build warnings
  separately from successful page generation and search indexing.
