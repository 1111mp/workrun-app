# Desktop testing

Run these commands from the repository root.

## Fast frontend checks

```sh
pnpm --filter workrun test
pnpm --filter workrun test:tauri
pnpm --filter workrun typecheck
```

`test` runs both Vitest projects. Existing `*.test.ts` files retain their Node
environment. New `*.tauri.test.ts` files run in jsdom with an isolated Tauri mock
environment, a `main` window, event mocking, and cleanup after each test.

Use `mockTauriCommands` from `@/test/tauri` to supply command results or throw
backend errors. It returns a Vitest spy for checking command names and arguments.
Unspecified commands reject with `Unhandled Tauri command`, so missing fixtures
cannot silently pass. Use the real `@tauri-apps/api/event` `emit()` and `listen()`
functions to test event handling; await subscriptions before emitting events.
Tauri's event mock provides partial event support, not full native window routing.

These tests exercise frontend code and the JavaScript Tauri APIs. They do not run
Rust, Python, native dialogs, or filesystem operations. Existing `vi.mock()` tests
can be migrated when touching them; they do not need a wholesale rewrite.

## Real desktop UI checks

```sh
# Build once, and rebuild after frontend or Rust changes.
pnpm --filter workrun test:e2e:build
pnpm --filter workrun test:e2e

# Run one spec.
pnpm --filter workrun test:e2e --spec test/e2e/onboarding.spec.ts
```

WebdriverIO uses `@wdio/tauri-service` with its embedded WebDriver provider on
macOS, Windows, and Linux. A graphical desktop session and the usual Tauri build
prerequisites are required. The first build downloads the optional Rust plugins.
WebdriverIO uses 10.x. The installed `@wdio/tauri-service` 1.5.0 still declares
`webdriverio: ^9.0.0` and depends on 9.x globals internally, so pnpm reports peer
dependency mismatches. Do not suppress those warnings or assume upstream support.
Re-run the desktop suite when upgrading either dependency; project compatibility
checks cover onboarding, real IPC, command mocking, refresh, and native screenshots.

The WDIO configuration and specs use TypeScript, loaded by `tsx`.
The environment runner remains `scripts/e2e.mjs` and runs directly with Node.js.
`tsconfig.e2e.json` includes WDIO and Mocha types and is checked by the normal
`pnpm --filter workrun typecheck` command.

The build enables Cargo feature `e2e`, imports the frontend bridge only in Vite
mode `e2e`, and uses `tauri.e2e.conf.json` for test permissions and a separate
application identifier. Normal builds do not enable these plugins or permissions.
Cargo's existing build cache is reused; the runner launches a dedicated copy at
`apps/desktop/target/e2e/workrun` (`workrun.exe` on Windows). On macOS it builds
and copies `Workrun E2E.app` into that directory so native bundle resource lookup
works correctly.

Every invocation creates a fresh temporary data directory, seeds an empty personal
workspace with English/light onboarding settings, and disables automatic updates
and autostart. Onboarding remains incomplete so the UI still shows the mode picker.
An E2E build requires `WORKRUN_E2E_DATA_DIR` and never falls back to personal
application data.
Keep tests independent; specs needing different starting state should arrange
their own fixtures rather than depend on a previous spec.

The initial smoke test checks database readiness and covers personal onboarding,
validation of an empty name, real IPC persistence, and restoration after reload.
Failed tests save screenshots
and WDIO logs to `apps/desktop/test-results/desktop/`. The runner prints the
temporary workspace path; it is retained for inspecting configuration, database,
and Rust logs after the run.

## AI verification workflow

For service/state changes, add a failing Vitest regression case, then run the
relevant project and typecheck. For visible interaction changes, also rebuild
and run the relevant WDIO spec. Inspect failures before changing expectations.
Report which checks ran and distinguish mocked frontend checks from real desktop
checks. A mocked successful run does not establish that a real workflow executes.

References: [Tauri mocks](https://v2.tauri.app/develop/tests/mocking/),
[Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/).
