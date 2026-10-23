# Workrun documentation media

Put the final screenshots and videos in folders matching the paths named in the
documentation, for example `quickstart/01-api-key.png`.

The homepage hero highlights conversational workflow orchestration and uses:

- `homepage/start-light.png`: the `/start` page in light mode.
- `homepage/start-dark.png`: the same page in dark mode.

Capture both at the same window size and crop, with the model selector and
conversation composer visible. Use matching sample content in both themes.
The site displays the screenshot matching the documentation theme, at its natural
aspect ratio without cropping or text overlays. Until both files are present,
it shows a task example instead. Rebuild after adding the pair.

The older `homepage/workflow-editor-light.png` and `workflow-editor-dark.png`
are retained as editor assets; they are no longer the homepage hero.

The homepage workflow demonstration uses
`homepage/workflow-run-through.mp4`. It shows a completed workflow run; keep
the recording free of secrets, personal data, team URLs, and customer data.

The current documentation uses visible “素材占位” callouts rather than broken
image or video elements. After an asset is added, replace the matching callout
with a relative Markdown image, for example:

```md
![设置页的 Provider API 密钥输入框，密钥已遮蔽。](/media/quickstart/01-api-key.png)
```

For a video, upload an MP4 to the same relative path and use a native video
element with a text fallback and a poster image. Do not capture secrets,
personal data, team URLs, or customer data in documentation media.

## Conversational sales-analysis demonstration

`conversational-workflows/sales-analysis.mp4` is embedded in both guides, with
`conversational-workflows/sales-analysis-poster.jpg` as its poster frame.
The web export is H.264/yuv420p at 1852 × 1080, 15 fps, with the source AAC audio
and full 193-second duration preserved. It is about 20.8 MiB, below Cloudflare
Pages' [25 MiB per-asset limit](https://developers.cloudflare.com/pages/platform/limits/#file-size).
The MP4 uses faststart so metadata is available before the full file downloads.
Keep original recordings outside `public/`; only the web export is deployed.

Use `public/examples/data/sales.csv` and keep the entire sequence in one conversation:

1. Attach the CSV and send `帮我分析一下这份销售数据。`; show the analysis.
2. Send `以后要重复做，整理成流程，先不要运行。`; show the plan, any revisions,
   plan approval, and the saved workflow. Do not run at this stage.
3. Send `帮我执行一下呢`; show the selected workflow and inputs, confirm execution,
   then show progress and results (total quantity 20, total sales amount 3300).

`conversational-workflows/token-usage.png` shows the recorded token-usage panel
for this walkthrough and is embedded in both guides. It is an example of one
conversation, not a fixed token budget for the task.

The English and Chinese guides use the same recording, CSV, and calculation
checks. After replacing the recording, verify duration, text legibility, browser
playback, and the sizes of all assets in the production build.
