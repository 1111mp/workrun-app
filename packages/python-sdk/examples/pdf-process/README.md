# PDF Process 文件闭环

这个示例读取 Workflow 上传的 PDF，生成两个持久化资源：

- `processedPdf`：重新保存的完整 PDF，保留页面内容，可预览、下载。
- `report`：按 `--- Page N ---` 分隔的 UTF-8 文本文件，可下载，也可供下游 Process 读取。

同时返回 `pageCount`、`textPageCount` 和 `warnings`。它不调用模型，也不生成 AI 摘要。
扫描页无法提取文字时会给出 OCR 提示；加密 PDF 会明确失败。

## 创建 Workflow App

1. 在 Workrun 的 Apps 页面创建一个 **Workflow App**，命名为 `PDF 文件处理`。
2. 打开 App 项目目录，将本目录的 `main.py` 复制到项目中，替换初始入口文件。
3. 在该项目目录安装依赖：

   ```sh
   uv add pypdf
   ```

   Workrun 创建的项目已包含 `workrun-sdk`，不要复制 SDK 项目自己的 `pyproject.toml`。

4. 编辑 App 输入 Schema，将 `contract.json` 的 `inputs` 对象粘贴到输入配置中。
5. 编辑 App 输出 Schema，将 `contract.json` 的 `outputs` 对象粘贴到输出配置中。
6. 保存 App。入口保持 `main.py`，版本可以使用 `0.1.0`。

输入与输出配置都是字段名到 JSON Schema 的映射，不要粘贴整个 `contract.json`。
资源字段的类型是 `object`，它表示 ArtifactRef；不要使用字符串文件路径。

## 创建测试 Workflow

```text
Start → Process（PDF 文件处理）→ End
```

1. 新建任务模式的 Workflow，名称为 `PDF Process 验收`。
2. 在运行输入中添加一个必填字段：Key 为 `document`，显示名称为 `PDF 文件`，类型为 **文件**。
3. 添加 Process 节点，在节点设置中选择刚创建的 Workflow App。
4. 添加 End，按上图连接。无需配置模型、Agent 或工具。
5. 点击运行，选择一份未加密的 PDF。
6. 核对页数与原文件一致；在结果中预览或下载 `processed.pdf`，下载 `extracted-text.txt`，检查页码标记及正文。
7. 重启 Workrun 后打开运行历史，确认两份输出仍可访问。生成文件的临时目录已删除，历史读取的是 Workrun 保存的快照。

例如，4 页的文本 PDF 应返回 `pageCount = 4`；`textPageCount` 为至少含有可提取文字的页数。
它不保证扫描文档的文字识别，不含 OCR。再次运行会生成新的资源 ID。

## 下游节点读取

Process 输出默认在其私有 State 中。在该 Process 的 State 权限中，将下游节点加入**可读节点**。
下游收到的是平铺输入：`report`、`processedPdf` 等字段，不是 `nodes.<id>.processedPdf`。
不要把输出重新命名为 `document`，否则可能与上传文件的全局键冲突。

下游 Process 可以这样核对结果：

```python
import json
import sys
from pypdf import PdfReader
from workrun_sdk import artifacts, process

state = json.load(sys.stdin)
text = artifacts.read(state["report"]).decode("utf-8")
pdf = artifacts.path(state["processedPdf"])
process.result({
    "verifiedPages": len(PdfReader(pdf).pages),
    "textCharacters": len(text),
})
```

下游 App 也需安装 `pypdf`，并声明与上述代码对应的输入输出 Schema。
若下游是 Gemini Agent，模型附件来源填 `processedPdf`，并授权它读取 Process 的 State。

## 仓库自动验收

```sh
uv sync --project packages/python-sdk
cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --lib python_pdf_process_generates_durable_files_for_authorized_downstream_nodes -- --ignored --nocapture
```

Unix 环境下该测试使用真实 Python 子进程、Workrun PythonRuntime、原生 IPC、两页文本 PDF 和真实资源存储。
它验证输入原文件删除后仍可处理、输出 Schema、临时目录清理后资源仍有效、State 的下游读取权限，
以及另一个 Process 通过 SDK 读取生成的 PDF 和文本。原生预览窗口和下载对话框需在桌面界面手动验收。
