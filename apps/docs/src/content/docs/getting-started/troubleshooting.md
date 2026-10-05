---
title: FAQs and troubleshooting
description: Resolve common installation and startup problems on macOS and Windows.
---

This page covers common desktop-app installation and startup problems. Before trying a workaround, make sure that you downloaded the installer for your operating system and CPU architecture from [Workrun GitHub Releases](https://github.com/1111mp/workrun-app/releases/latest).

## macOS

### macOS says Workrun is damaged or cannot verify the developer

Workrun may be blocked by macOS Gatekeeper when macOS cannot verify the application developer.

1. Dismiss the warning.
2. Open **System Settings → Privacy & Security**.
3. Find the message about Workrun and select **Open Anyway**.
4. Confirm by selecting **Open**.

Apple's instructions differ slightly by macOS version. See [Open a Mac app from an unidentified developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac) if you cannot find this option.

If the warning continues after following Apple's instructions, remove the quarantine attribute from the installed app in Terminal:

```bash
xattr -d com.apple.quarantine /Applications/Workrun.app
```

For an installer that cannot be opened, use its actual downloaded path instead:

```bash
xattr -d com.apple.quarantine /path/to/Workrun-installer.dmg
```

### macOS says it cannot check the app for malicious software

Follow Apple's [app security guidance](https://support.apple.com/guide/mac-help/protect-your-mac-from-malware-mh40596/mac) for your macOS version, then retry the steps above.

## Windows

### Windows reports that a VCRUNTIME DLL is missing

The Microsoft Visual C++ Runtime is missing. Download and install the package matching your computer architecture, then restart Workrun:

| Architecture | Download                                                                |
| ------------ | ----------------------------------------------------------------------- |
| x64          | [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe)     |
| x86          | [vc_redist.x86.exe](https://aka.ms/vs/17/release/vc_redist.x86.exe)     |
| ARM64        | [vc_redist.arm64.exe](https://aka.ms/vs/17/release/vc_redist.arm64.exe) |

### Windows says this app cannot run on your PC

The installer probably does not match your computer architecture. Check **Settings → System → About → System type**, then download the corresponding installer from [Workrun GitHub Releases](https://github.com/1111mp/workrun-app/releases/latest):

- x64 Windows needs the x64 installer.
- ARM64 Windows needs the ARM64 installer.
- x86 Windows needs the x86 installer.

### Workrun starts without a window, exits immediately, or only shows a tray icon

Workrun needs Microsoft Edge WebView2 Runtime to render its interface.

1. If you used software to disable Microsoft Edge, make sure it did not also disable WebView2 Runtime.
2. Install or repair [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
3. If WebView2 cannot be installed, use the installer with the bundled WebView2 runtime when one is available in the [release assets](https://github.com/1111mp/workrun-app/releases/latest).

### WebView2 Runtime cannot be installed

Enable Windows Update, then retry the WebView2 installation. If it still fails, use the release asset that includes the bundled WebView2 runtime when available.

## Still need help?

[Open a GitHub issue](https://github.com/1111mp/workrun-app/issues/new/choose) with your operating system version, Workrun version, installer architecture, and the complete error message.
