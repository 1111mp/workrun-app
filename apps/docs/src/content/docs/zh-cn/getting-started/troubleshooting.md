---
title: 常见问题与故障排查
description: 排查 macOS 和 Windows 上常见的安装与启动问题。
---

本页覆盖桌面端常见的安装和启动问题。尝试任何处理方式前，请先确认已从 [Workrun GitHub Releases](https://github.com/1111mp/workrun-app/releases/latest) 下载与你的操作系统和芯片架构相符的安装包。

## macOS

### 提示应用已损坏，或无法验证开发者

当 macOS 无法验证应用开发者时，Gatekeeper 可能会阻止 Workrun 打开。

1. 关闭提示窗口。
2. 打开 **系统设置 → 隐私与安全性**。
3. 找到与 Workrun 有关的提示，点击 **仍要打开**。
4. 在确认窗口中点击 **打开**。

不同 macOS 版本的操作界面会略有不同。如果找不到该选项，请参阅 Apple 的[打开来自身份不明开发者的 Mac App](https://support.apple.com/zh-cn/guide/mac-help/mh40616/mac)说明。

如果按 Apple 的指引操作后仍然提示错误，可以在终端中移除已安装应用的隔离属性：

```bash
xattr -d com.apple.quarantine /Applications/Workrun.app
```

如果无法打开安装包，请将命令中的路径替换成实际下载位置：

```bash
xattr -d com.apple.quarantine /path/to/Workrun-installer.dmg
```

### 提示 Apple 无法检查 App 是否包含恶意软件

请根据你的 macOS 版本，参考 Apple 的[防护 Mac 免受恶意软件侵害](https://support.apple.com/zh-cn/guide/mac-help/mh40596/mac)说明，然后重试上述操作。

## Windows

### 提示找不到 VCRUNTIME DLL

这是因为系统缺少 Microsoft Visual C++ Runtime。请下载并安装与你的电脑架构相符的版本，再重新启动 Workrun：

| 架构  | 下载地址                                                                |
| ----- | ----------------------------------------------------------------------- |
| x64   | [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe)     |
| x86   | [vc_redist.x86.exe](https://aka.ms/vs/17/release/vc_redist.x86.exe)     |
| ARM64 | [vc_redist.arm64.exe](https://aka.ms/vs/17/release/vc_redist.arm64.exe) |

### 提示“此应用无法在你的电脑上运行”

通常是安装包与电脑架构不匹配。打开 **设置 → 系统 → 系统信息 → 系统类型** 查看架构，并从 [Workrun GitHub Releases](https://github.com/1111mp/workrun-app/releases/latest) 下载对应安装包：

- x64 Windows 对应 x64 安装包；
- ARM64 Windows 对应 ARM64 安装包；
- x86 Windows 对应 x86 安装包。

### 启动后没有窗口、立即退出，或只显示托盘图标

Workrun 需要 Microsoft Edge WebView2 Runtime 来渲染界面。

1. 如果使用过禁用 Microsoft Edge 的软件，请确认它没有同时禁用 WebView2 Runtime。
2. 安装或修复 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/zh-cn/microsoft-edge/webview2/)。
3. 如果无法安装 WebView2，请在 [Release 的 Assets](https://github.com/1111mp/workrun-app/releases/latest) 中查找内置 WebView2 Runtime 的安装包（如有）。

### WebView2 Runtime 无法安装

先启用 Windows Update，再重试安装 WebView2。如果仍然失败，请在 Release 的 Assets 中使用内置 WebView2 Runtime 的安装包（如有）。

## 仍然需要帮助？

请[创建 GitHub issue](https://github.com/1111mp/workrun-app/issues/new/choose)，并附上操作系统版本、Workrun 版本、安装包架构以及完整的错误信息。
