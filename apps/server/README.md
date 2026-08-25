# Workrun Server

Workrun 的 NestJS 服务端应用。当前提供基础 HTTP 服务，并使用 SWC 加速构建、Vitest 运行单元测试与端到端测试。

## 环境要求

- Node.js 24 或更高版本
- pnpm 11

依赖请在仓库根目录安装：

```bash
pnpm install
```

## 开发

从仓库根目录启动服务：

```bash
pnpm server:dev
```

服务默认监听 `http://localhost:3000`。访问根路径可得到：

```text
Hello World!
```

也可以直接运行此 workspace 的脚本：

```bash
pnpm --filter workrun-server dev
```

使用 `PORT` 指定其他端口：

```bash
PORT=4000 pnpm --filter workrun-server dev
```

## 构建与运行

```bash
# 使用 Nest CLI 的 SWC builder 编译到 dist/
pnpm --filter workrun-server build

# 运行已编译的服务
pnpm --filter workrun-server start:prod
```

`nest-cli.json` 已启用 SWC builder；`@swc/core` 负责转换 TypeScript，保留 Nest 所需的 decorator metadata。

## 测试

项目使用 Vitest，并通过 `unplugin-swc` 处理 Nest 的 TypeScript decorators。

```bash
# 单元测试
pnpm --filter workrun-server test

# 监听模式
pnpm --filter workrun-server test:watch

# V8 覆盖率报告（输出到 coverage/）
pnpm --filter workrun-server test:cov

# 端到端测试
pnpm --filter workrun-server test:e2e
```

## 代码质量

```bash
# 静态检查
pnpm --filter workrun-server oxlint

# 自动修复可修复的问题
pnpm --filter workrun-server oxlint:fix

# 检查格式
pnpm --filter workrun-server format

# 写入格式化结果
pnpm --filter workrun-server format:write
```

## 目录结构

```text
src/
├── app.controller.ts        HTTP 控制器
├── app.controller.spec.ts   单元测试
├── app.module.ts            根模块
├── app.service.ts           业务服务
└── main.ts                  应用入口
test/
└── app.e2e-spec.ts          端到端测试
vitest.config.mts            单元测试与覆盖率配置
vitest.e2e.config.mts        端到端测试配置
nest-cli.json                Nest CLI / SWC 构建配置
```
