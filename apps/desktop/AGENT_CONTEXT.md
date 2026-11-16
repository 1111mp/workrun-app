# Agent 模块与对话执行流程

运行时调度和模型角色分别维护。`main_agent` 模块已移除；任务角色的代码、SDK 名称和提示词目录统一为 `task_agent`。

## 模块边界

| 模块                                                                                                 | 职责                                                                 |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [runtime.rs](src-tauri/src/module/assistant/runtime.rs)                                              | 配置加载、请求入口、原生状态检查、调用路由并分发；自身不承担模型角色 |
| [router/mod.rs](src-tauri/src/module/assistant/router/mod.rs)                                        | 无工具、无 Skill 的三分类路由                                        |
| [conversation_agent/mod.rs](src-tauri/src/module/assistant/conversation_agent/mod.rs)                | 普通回答，以及一次转交任务 Agent 的内部入口                          |
| [task_agent/mod.rs](src-tauri/src/module/assistant/task_agent/mod.rs)                                | 准备任务上下文、工具与授权状态                                       |
| [task_agent/runner.rs](src-tauri/src/module/assistant/task_agent/runner.rs)                          | ADK Runner、任务工具调用、规划/编排委派及结果回收                    |
| [authorization.rs](src-tauri/src/module/assistant/authorization.rs)                                  | 请求范围解释与授权证据检查；路由结果不能代替授权                     |
| [planning_agent/](src-tauri/src/module/assistant/planning_agent/)                                    | 规划与修订可审核的 Workflow 提案                                     |
| [workflow_agent/](src-tauri/src/module/assistant/workflow_agent/)                                    | 根据已确认的计划配置、校验并保存 Workflow                            |
| [model.rs](src-tauri/src/module/assistant/model.rs)、[sdk.rs](src-tauri/src/module/assistant/sdk.rs) | 共享模型适配、流接收、统计、SDK 桥接                                 |

## 普通对话的实际流程

```text
用户消息
  → session.rs：取得当前会话、历史和原生上下文
  → runtime::run_turn：检查待确认操作、计划和恢复状态
  → router::choose：一次模型调用，只输出 conversation / task / workflow
      ├─ conversation → conversation_agent::respond
      │                    ├─ 普通文本 → 返回 AssistantReply
      │                    └─ handoff_to_task → task_agent::run（同一原始请求，只转交一次）
      ├─ task → task_agent::run
      └─ workflow → 原生运行器安排 workflow_planner
                        → 用户确认计划版本
                        → workflow_author 配置和保存
```

普通对话共两次模型调用：路由和回答。对话路径不会执行任务 Agent 的模型调用。Workflow 路由复用同一原生运行器连接规划 Agent，初始委派不需要任务模型再次选择去向。创建、保存与执行保持独立授权。

仅创建或修改、不执行的请求在保存成功后，由原生运行器记录结果并更新方案卡片，直接结束当前调用；不再让编排 Agent 和任务 Agent 各生成一次完成总结。失败时仍可修复后重试，需要继续执行的授权流程不受此收尾规则影响。

对话在卡片之外显示独立说明：规划完成后提示查看/确认，创建或修改成功后依据原生 validation/published/executed 字段说明保存及执行状态；该轮已有助手正文时不重复补文案。这些说明不增加模型调用，也不改变工作流节点。模型返回的可展示推理通过 Reasoning 事件传给前端；规划和创建阶段不转发内部工具 JSON 或控制正文。

路由只读取最新文本最多 2400 字符、之前四条可见对话各最多 600 字符，以及文件/媒体存在标志和计划状态摘要。工具结果正文不会发送给路由。处理 Agent 接收原始历史，路由预览不会替换原始消息；共享层继续执行既有格式适配和内容投影。

对话 Agent 的请求包含自己的 AGENT.md、工作区自定义指令和当前历史。没有 Skill 或业务工具定义，只有 `handoff_to_task` 这个不产生业务效果的转交声明。转交时不插入伪造用户消息，不改变原始消息索引，也不重新路由。

底层按流接收模型输出，但 `generate_answer` 当前会先收齐正文，确认是否存在转交调用：普通回答通过 `TextReplace` 一次显示；含转交调用的文字作为 Activity 处理。最终回答由原生会话流程保存并返回前端。

待确认工具、已确认计划续建和回执恢复优先走原生状态路径，不让路由解释审批结果。Workflow 路由仅放行读取和保存待审核提案，不再重复调用意图模型；创建、执行和外部工具权限仍经过原生关卡。自然语言审批使用 authorization/CONFIRMATION.md，仅解释当前待确认项；按钮决定直接绑定原生 ID 和版本。普通任务的实际操作仍提取当前请求证据。错误路由不能授予执行权限；无效的路由 JSON 保守转入任务处理，网络错误仍报告为错误。

## 各角色提示词的唯一维护源

| 角色 | 固定提示词                                                                                                                                                                               | 动态内容 / 能力                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 路由 | [router/AGENT.md](src-tauri/src/module/assistant/router/AGENT.md)                                                                                                                        | 有限对话预览和状态摘要；无工具、无 Skill；结构化三分类输出                      |
| 对话 | [conversation_agent/AGENT.md](src-tauri/src/module/assistant/conversation_agent/AGENT.md)                                                                                                | 工作区指令、当前历史、唯一内部转交声明                                          |
| 任务 | [task_agent/AGENT.md](src-tauri/src/module/assistant/task_agent/AGENT.md)                                                                                                                | 工具契约、可选 Skill 摘要、文件引用、消息索引、所需原生状态；Skill 正文按需读取 |
| 规划 | [planning_agent/AGENT.md](src-tauri/src/module/assistant/planning_agent/AGENT.md) ＋ [workflow-planning.md](src-tauri/src/module/assistant/planning_agent/skills/workflow-planning.md)   | 原始任务、当前完整计划、可见对话、授权附件和首选模型信息；只读发现与提案工具    |
| 编排 | [workflow_agent/AGENT.md](src-tauri/src/module/assistant/workflow_agent/AGENT.md) ＋ [workflow-authoring.md](src-tauri/src/module/assistant/workflow_agent/skills/workflow-authoring.md) | 原生已确认计划、派生任务、现有定义、附件和模型信息；配置校验和保存工具          |

[authorization/INSTRUCTIONS.md](src-tauri/src/module/assistant/authorization/INSTRUCTIONS.md) 用于实际操作前的请求范围证据；有待确认项时改用 [authorization/CONFIRMATION.md](src-tauri/src/module/assistant/authorization/CONFIRMATION.md)，只解释当前审批回复。两者均不用于普通对话，也不替代原生权限校验。详细工具 schema 是请求的独立部分。

这些角色复用当前选定模型；没有新增模型配置框架。Langfuse 和用量账本区分 `routing`、`conversation`、`task`、`intent`（授权解释）、`planning`、`authoring`。统计包含路由调用，不隐藏其成本。

## 验证与打包

```sh
node apps/desktop/scripts/generate-workflow-reference.mjs
node apps/desktop/scripts/generate-workflow-reference.mjs --check
cargo test --manifest-path apps/desktop/Cargo.toml --lib module::assistant --offline
```

打包脚本从各角色目录复制提示词，并单独复制共享授权指令。实际模型评测仍使用 `WORKRUN_ASSISTANT_LIVE_CONFIG_DIR`、`WORKRUN_ASSISTANT_EVAL_CASES` 和 `WORKRUN_ASSISTANT_EVAL_REPORT`，运行隔离测试能力。脚本测试不能证明实际语义质量或 token 节省。修改后需重新构建并重启桌面端。

编排基础契约包含文档形状、字段类型、连线与状态发布规则。选中节点说明默认不附带 CodeAct 运行环境全文；文件、工具或语言支持不明确时，通过 `get_workflow_reference(topic="codeact-runtime")` 按需读取。保存与待确认工具的观测结果在原生执行边界写入，再结束 SDK 调用，避免成功保存却缺失工具返回值。

编排节点契约默认返回原生语义、完整 dataSchema 和分支句柄，从同一份校验契约派生。原生 authoring 上下文直接附带方案建议及现有定义涉及的节点契约（含 Start/End），不固定业务拓扑；选择其他节点时仍可查询。规划阶段先明确输出生产责任，不添加用户未要求的业务范围或校验。

规划指令从原生节点 planning.capability 自动附带简短能力总览，用于一次选择候选执行器；具体限制仍按需读取。引用工具的显式 `detail=summary` 对手册和指定节点的示例同样生效，不会静默返回完整文档。

编排节点文档统一经 `get_workflow_reference` 读取，不再同时注册 `workflow-node-*` Skill。`configuration` 指定 `node_types` 时复用所选节点契约；不指定时才读取共享资源配置手册。基础指令明确可见输入不是自动注入的 Python 变量，以及 final_result、globalKeys 和工作流输出之间的关系。

创建侧状态/格式摘要使用源手册 Essentials，运行环境摘要包含实际语言语义，不再截取免责声明。规划侧本轮实验未改善，已保留基线行为。
