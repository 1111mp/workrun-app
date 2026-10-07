# CodeAct 资源文件使用与验收

## 自动文件环境

CodeAct 节点执行前会收集其**可见输入 State** 中的资源引用，校验快照完整性，复制到只读 `/artifacts`。无需填写宿主机路径。整个字段被标为 sensitive，或上游未授予节点读取权限时，该资源不会映射。

读取 `/artifacts/manifest.json` 可获得映射列表：

```json
[
  {
    "reference": {
      "$type": "artifact",
      "id": "<UUID>",
      "version": 1,
      "name": "input.txt",
      "mimeType": "text/plain",
      "size": 12
    },
    "path": "/artifacts/<UUID>/input.txt"
  }
]
```

`reference.id` 可与输入中的引用匹配。UUID 目录避免同名文件覆盖；同一引用只映射一次。清单不会提供真实宿主机路径。

模型在一次节点执行的多个脚本步骤之间可以继续访问已写入 `/outputs` 的文件。节点成功完成后，此目录内的普通文件被保存为不可变 Artifact，引用数组写入 `nodes.<节点ID>.artifacts`。空目录对应空数组。已有结果预览、下载与历史记录功能可直接使用这些引用。

只收集 `/outputs`，不收集用户额外挂载目录。输入和输出各最多 100 个文件、合计 512 MiB；输出最多嵌套 31 层目录。拒绝符号链接与特殊文件。`/artifacts`、`/outputs` 及其子路径不能配置为额外挂载。

## 新建单节点测试 Workflow

1. 新建 task Workflow，连接 `Start → CodeAct Agent → End`。
2. 添加必填输入 `document`，类型 `file`，关闭 sensitive。准备一个 UTF-8 `input.txt`，内容例如 `alpha\nbeta\n`（实际换行）。
3. 为 CodeAct 选择支持代码生成的模型，保留默认脚本时间与内存限制。额外挂载、环境变量、工具、输出 JSON Schema 均留空。
4. 填写 instruction：

   ```text
   处理用户输入 document 对应的 UTF-8 文本文件。
   使用 pathlib.Path 和 json 读取 /artifacts/manifest.json，按 document.id 选择文件。
   读取文本，将其转换为大写，写入 /outputs/processed.txt。
   将原文的字符数、行数写入 /outputs/report.json。
   返回 final_result，value 用中文说明处理结果与生成的文件名。
   不要修改输入文件，不要安装第三方库，不要构造资源引用。
   ```

5. 上传文本并运行。节点 State 的 `artifacts` 应包含 `processed.txt` 与 `report.json`，下载确认内容。输入原件应保持不变。
6. 重启应用后打开历史记录，确认两个生成文件仍能下载；移动原始输入文件后重新运行历史输入，确认依然可读取存储的快照。

## 脚本示例

Monty 使用脚本最后一个表达式返回结果，不能在顶层使用 `return`：

```python
from pathlib import Path
import json

files = json.loads(Path("/artifacts/manifest.json").read_text())
text = Path(files[0]["path"]).read_text()
Path("/outputs/processed.txt").write_text(text.upper())
Path("/outputs/report.json").write_text(json.dumps({
    "characters": len(text),
    "lines": len(text.splitlines())
}))
{"type": "final_result", "value": "已生成 processed.txt 和 report.json"}
```

该示例选择第一个资源；多文件业务应通过引用 ID 明确选择，避免依赖清单顺序。模型实际使用输入 JSON 中的字段值，不需要在脚本里猜测宿主机路径。

## 下游与暂停恢复

- 在生产节点 State 读取权限中加入下游节点 ID。下游 Process 可用 `workrun_sdk.artifacts.read/path` 读取 `artifacts` 数组；下游 CodeAct 会自动映射可见引用。
- 多个可读上游都发布 `artifacts` 时，平铺输入可能发生同名键冲突，应按既有 State 规则调整工作流接口或读取权限。
- CodeAct 请求工具确认而暂停时，已生成文件先保存为快照，写入私有 checkpoint 元数据。恢复时还原到 `/outputs`，支持继续使用暂停前写入的文件。尚未完成的输出不会提前发布给下游。
- 新一次节点执行会重建临时文件环境。执行失败时不发布生成文件；成功发布的 Artifact 不依赖临时目录。

## 图片、视频和 PDF

这些资源也会映射为可读取字节的文件，但 Monty 不是完整 CPython，不能安装 pypdf、Pillow 或调用 ffmpeg，也不会自动完成视觉识别或 OCR。

需要解析或转换时，配置对应 Process 工具并传入资源引用；工具通过 SDK 返回生成文件引用。也可以先用 Process 节点生成文本，再将文本资源交给 CodeAct。CodeAct 的自动文件清单在节点开始时建立，工具在本次执行中返回的新引用可继续传给其他 Process 工具；需要自动文件映射时交给后续 CodeAct 节点。

## 自动验证

```sh
cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --lib module::workflow::codeact_agent::tests
```

测试使用真实 Monty 沙箱与文件存储，并以模型固定响应验证完整的 CodeAct 流式执行到 State 发布。第三方模型实际生成代码、桌面预览下载和重启历史记录仍需在运行中的桌面应用验收。
