# Workrun documentation media

Put the final screenshots and videos in folders matching the paths named in the
documentation, for example `quickstart/01-model-profile.png`.

The homepage hero uses `homepage/workflow-editor-dark.png` in dark mode and
`homepage/workflow-editor-light.png` in light mode. Keep both exports at those
paths and with the same crop, so theme switching does not shift the composition.

The current documentation uses visible “素材占位” callouts rather than broken
image or video elements. After an asset is added, replace the matching callout
with a relative Markdown image, for example:

```md
![新建模型 Profile 的表单，密钥已遮蔽。](/media/quickstart/01-model-profile.png)
```

For a video, upload an MP4 to the same relative path and use a native video
element with a text fallback and a poster image. Do not capture secrets,
personal data, team URLs, or customer data in documentation media.
