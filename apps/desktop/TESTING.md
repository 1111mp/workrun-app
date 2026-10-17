# Desktop testing

Run these commands from the repository root.

## Fast frontend checks

```sh
pnpm --filter workrun test
pnpm --filter workrun test:component
pnpm --filter workrun test:tauri
pnpm --filter workrun test:browser
pnpm --filter workrun typecheck
```

The Frontend Check pull-request workflow runs only the unit, component, and
Tauri mock projects, and uploads the Vitest console log on failure. It does not
download or launch a browser. Browser component tests and native desktop E2E
remain local manual checks.

To run the same fast suites as CI:

```sh
pnpm --filter workrun test --project unit --project component --project tauri
```

`test` runs all four Vitest projects (including the browser suite):

- `unit`: ordinary `*.test.ts` files run in Node for logic, services, and stores.
- `component`: `*.test.tsx` files (excluding `*.browser.test.tsx`) run in jsdom with React Testing Library,
  explicit automatic cleanup, and `jest-dom` assertions.
- `browser`: `*.browser.test.ts` / `*.browser.test.tsx` files run in headless
  WebKit on macOS/Linux or Chromium on Windows through Playwright with `vitest-browser-react` and the application CSS.
- `tauri`: `*.tauri.test.ts` files run in jsdom with an isolated Tauri mock
  environment, a `main` window, event mocking, and cleanup after each test.

For component tests, use JSX with `render()` or `renderHook()` from
`@testing-library/react`. Prefer role/name queries and `userEvent.setup()` for
ordinary clicks and input, and `findBy*` / `waitFor()` for asynchronous results.
Keep `act` around direct store updates, native event callbacks, or controlled
animation frames when these updates happen outside Testing Library interactions.
Explicit `unmount()` remains useful when testing listener cleanup or remounting.
Some timing and DOM identity tests intentionally retain low-level DOM access.

Each test must still own its QueryClient and reset any shared application stores
or service mocks it changes. DOM cleanup does not reset application state.
When testing clipboard behavior, initialize `userEvent` before installing a
custom clipboard fixture because `userEvent.setup()` installs its own stub.

Use `mockTauriCommands` from `@/test/tauri` to supply command results or throw
backend errors. It returns a Vitest spy for checking command names and arguments.
Unspecified commands reject with `Unhandled Tauri command`, so missing fixtures
cannot silently pass. Use the real `@tauri-apps/api/event` `emit()` and `listen()`
functions to test event handling; await subscriptions before emitting events.
Tauri's event mock provides partial event support, not full native window routing.

These tests exercise frontend code and the JavaScript Tauri APIs. They do not run
Rust, Python, native dialogs, or filesystem operations. Existing `vi.mock()` tests
can be migrated when touching them; they do not need a wholesale rewrite.

## Real browser component checks

On macOS, run browser tests outside an agent's restricted execution sandbox
(request elevated execution when required). In this environment, sandboxed
WebKit launches have aborted in macOS `_RegisterApplication` before loading
tests and triggered a “Playwright quit unexpectedly” system dialog. Headless
mode still initializes a native application. Unit/component/Tauri mock tests
can remain sandboxed; do not suppress macOS crash reporting to hide this failure.

Vitest keeps failure screenshots in `apps/desktop/.vitest/attachments/`.
Each test run (including watch reruns) clears the previous run's attachments.
Successful tests should not save manual screenshots into source directories;
use screenshot assertions when a visual regression check is required.

Install the browser for your platform after installing dependencies (repeat after Playwright updates):

```sh
# macOS / Linux (Linux CI may also need --with-deps)
pnpm --filter workrun exec playwright install webkit
# Windows
pnpm --filter workrun exec playwright install chromium
pnpm --filter workrun test:browser
# Run one file, or open the browser for debugging.
pnpm --filter workrun test:browser message-scroller-timing
pnpm --filter workrun test:browser --browser.headless=false
```

Use `*.browser.test.tsx` for components that need real layout, scrolling, or browser
observers. Import `render` from `vitest-browser-react` and await rendering and
rerendering. Use `vitest/browser` locators and user events, `expect.element()` for
DOM assertions, and `expect.poll()` for asynchronous geometry changes. The render
library automatically cleans up components between tests. Do not import the jsdom
setup or replace real layout APIs with mocks in these cases.

The message scroller suite checks content growth/shrinkage, viewport resizing,
and preservation of the user's position after keyboard scrolling using real
ResizeObserver and animation frames. The engine selection follows Tauri: WebKit
for WKWebView on macOS and WebKitGTK on Linux, Chromium for WebView2 on Windows.
Playwright uses its own browser builds, so these checks do not run the system
WebView or establish native WebView compatibility; use desktop E2E for that. Fast suites can run without
launching a browser with `test --project unit --project component --project tauri`.

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

Each selected spec gets a fresh temporary data directory and a separate native
application process. The runner accepts `--spec path` / `--spec=path` and glob
patterns relative to `apps/desktop`; other options are forwarded to WDIO.
The default fixtures seed an empty personal
workspace with English/light onboarding settings, and disable automatic updates
and autostart. Onboarding remains incomplete so the UI still shows the mode picker.
An E2E build requires `WORKRUN_E2E_DATA_DIR` and never falls back to personal
application data.
Keep tests independent; specs needing different starting state should arrange
their own fixtures rather than depend on a previous spec.

The onboarding smoke test checks database readiness and covers personal onboarding,
validation of an empty name, real IPC persistence, and restoration after reload.
Failed tests save screenshots
and WDIO logs to `apps/desktop/test-results/desktop/`. The runner prints the
temporary workspace path; it is retained for inspecting configuration, database,
and Rust logs after the run. Failure diagnostics also include the page HTML and
a JSON file identifying the workspace and restart phase.

The workflow smoke test seeds a local Python App using the bundled SDK wheel,
creates its workflow through real IPC, and starts execution through the UI.
It checks fixed input/output, completed history, and opening the saved output.
After the first successful run, the runner starts a second WDIO invocation with
the same workspace to check workflow, input, events, and output restoration after
a native application restart. The restart phase reads `workflow-run.json` from
that workspace; it does not create another run or substitute a page refresh.

```sh
pnpm --filter workrun test:e2e --spec test/e2e/workflow.spec.ts
```

The workflow fixture has no model service or package-index dependency. Its first
execution still requires network access to download Workrun's managed Python
3.12 runtime into the isolated workspace. The desktop test timeout allows four
minutes, while workflow completion is bounded at three minutes.

## AI verification workflow

For service/state changes, add a failing Vitest regression case, then run the
relevant project and typecheck. For visible interaction changes, also rebuild
and run the relevant WDIO spec. Inspect failures before changing expectations.
Report which checks ran and distinguish mocked frontend checks from real desktop
checks. A mocked successful run does not establish that a real workflow executes.

References: [Tauri mocks](https://v2.tauri.app/develop/tests/mocking/),
[Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/).
