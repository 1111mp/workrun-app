---
title: 安装与前置条件
description: 在本地启动 Workrun 桌面端的开发环境。
---

Workrun 是本地优先的桌面应用。使用发行包时，按对应平台的安装说明安装即可；从源码开发时，需要以下环境。

## 前置条件

- Node.js 24 或更高版本；
- pnpm 12；
- Rust 工具链和当前平台需要的 Tauri 构建依赖；
- 开发 Python App 时需要网络，以便 `uv` 下载 Python 与依赖。

## 启动开发环境

在仓库根目录执行：

```bash
pnpm install
pnpm app:dev
```

首次启动后，先创建模型 Profile，再按[快速开始](/zh-cn/getting-started/quickstart/)创建工作流。

## 常用命令

```bash
pnpm ui:dev
pnpm typecheck
pnpm oxlint
pnpm test
```

团队服务还需要 MongoDB 和认证相关环境变量。具体变量以 `apps/server/src/env.validation.ts` 为准。
