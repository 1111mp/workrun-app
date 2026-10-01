---
title: 安装与前置条件
description: 从 GitHub Releases 下载 Workrun，或为本地开发准备环境。
---

大多数用户只需下载安装包。只有在开发 Workrun、贡献代码或修改桌面端时，才需要从源码启动。

## 下载 Workrun

前往 [Workrun GitHub Releases](https://github.com/1111mp/workrun-app/releases/latest) 下载最新版本。

1. 在最新 Release 的 **Assets** 中，选择与你的操作系统和芯片架构相符的安装包；
2. 按系统安装流程完成安装；
3. 启动 Workrun。

Release 页面会列出当前版本实际提供的安装包和说明。请始终从该页面下载，不要从第三方站点获取安装包。

## 首次启动

首次启动时，按引导选择个人或团队工作区。随后：

1. 打开 **设置 → 模型**；
2. 为一个要使用的 Provider 填写 API 密钥；
3. 设置会自动保存；
4. 按[5 分钟快速开始](/zh-cn/getting-started/quickstart/)创建第一个工作流。

无需新建模型 Profile 或手动填写模型 ID。Workrun 提供内置模型目录；在 Agent 节点中选择与你已配置 Provider 对应的模型即可。使用 Ollama 时，填写本地或远程 Ollama 端点，而不是 API 密钥。

## 从源码运行（仅开发者）

如果你需要开发或修改 Workrun，请准备：

- Node.js 24 或更高版本；
- pnpm 12；
- Rust 工具链和当前平台所需的 Tauri 构建依赖；
- 网络连接：开发 Python App 时，`uv` 需要下载 Python 和依赖。

克隆仓库后，在仓库根目录执行：

```bash
pnpm install
pnpm app:dev
```

## 常用开发命令

```bash
# 仅启动桌面端前端
pnpm ui:dev

# 静态检查与测试
pnpm typecheck
pnpm oxlint
pnpm test
```

团队服务的本地开发还需要 MongoDB 和认证环境变量。以 `apps/server/src/env.validation.ts` 中的当前定义为准。
