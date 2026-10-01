# Workrun documentation media

Put the final screenshots and videos in folders matching the paths named in the
documentation, for example `quickstart/01-api-key.png`.

The homepage hero uses `homepage/workflow-editor-dark.png` in dark mode and
`homepage/workflow-editor-light.png` in light mode. Keep both exports at those
paths and with the same crop, so theme switching does not shift the composition.

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
