# Scheduled tasks

The `/schedules` page manages the same `schedules` rows as the existing App and
Workflow editors. The `schedule_agent` is a separate native runtime, with its own
instructions, six-tool catalog and `schedule_agent_sessions` storage. It does not
register the workflow planner, author, execution tools or specialist transfers.
Only provider adaptation, model usage accounting and read-only catalog access are
shared with the conversational assistant.

Rust responsibilities are organized around focused structs:

- `ScheduleAgent` owns the workspace-scoped store and conversation lifecycle.
- `SchedulingStore` owns the database pool and workspace identity, and handles
  schedule/session persistence, previews and atomic confirmations.
- `ScheduleTools` borrows the store and read-only catalog for tool discovery and
  execution.
- `ScheduleRuntime` owns process-local session leases and cancellation tokens.
- `ScheduleTaskManager` validates direct form edits and commits them without a
  model call or conversation write. Pause/resume and deletion use `ScheduleStore`.

Shared `ScheduleTiming`, `ScheduleDispatcher` and `ScheduleEvents` handle timing,
atomic occurrence claims and post-commit renderer notifications.

Tauri commands are thin function entry points that construct the active agent and
forward requests to its methods. The frontend command names and data contracts
remain independent of this organization.

## Change protocol

1. Discover an existing App or Workflow and read its actual input contract.
2. Collect missing information through persisted question cards.
3. Generate a native preview with a stable proposed task ID and the existing row's
   `updated_at` version. Previews cannot save or run tasks.
4. A task-card decision selects the native proposal ID. The native host rechecks
   the execution target and uses a conditional schedule write. The task mutation
   and session receipt commit in one transaction. Confirmed retries are no-ops.

Existing target definitions, inputs, editor metadata and publication policies are
preserved when changing timing. New personal Workflow tasks follow the latest
saved definition; new Team tasks follow published releases. New recipes use the
same typed serialization contract as the scheduler.

Detail-dialog edits, pause/resume and deletion use task interfaces directly.
They do not generate proposal cards, call the model or alter conversation history.
Deletion has an ordinary confirmation dialog; errors remain in the task dialog.
Task-result cards observe current task caches while earlier proposal cards retain
their confirmed snapshots. Direct task operations never put the chat composer
into a model-busy state.

Conversations and schedules have independent lifetimes. Removing a conversation
keeps its scheduled tasks. Removing a schedule retains the ordinary run records.
Pending cards, questions and conversation history survive reload. A response
interrupted by process termination is displayed as interrupted and never resumes
an approval automatically. Each session has a native lease and cancellation token;
model work is bounded to 12 rounds and 240 seconds.

## Conversation delivery

The task center and homepage share the Message/Bubble primitives, conversation
viewport and progress component. A renderer response record keeps the outgoing
user bubble visible across session creation and stale idle reads, until a native
user message takes its place. Native model deltas stream immediately; phase IDs
separate tool narration from the final answer. Tool names become localized
progress labels without exposing their arguments. The shared scroller respects
manual reading positions instead of forcing every update to the bottom.

Task and conversation reads have no polling intervals. Native `ScheduleEvents`
notifies the renderer after schedule/session commits and scheduler claims or
recovery; run status events refresh occurrence results. The renderer subscribes
before a single reconciliation read, cancels stale reads on notification, and
releases subscriptions when leaving the workspace. Streaming text still uses the
per-response IPC channel.

The task list and conversation are persistent tabs. Switching tabs preserves the
selected task/session and unsent input; the shared Dropdown Menu switches history
entries, including the currently selected entry. Messages and composers use the
same width classes as the homepage.

The sidebar starts a fresh conversation. The task list is an explicit tab and
opens a task's associated conversation, including tasks from multi-task sessions.
Message-card actions validate current task existence before opening the complete
detail dialog. A missing task produces a notice rather than a loading dialog.
Confirmation preserves the preceding reply and full card, updates only its status,
and appends the saved result. Native session revisions prevent late reads or IPC
receipts from replacing newer history. Native final responses and streamed text
share stable presentation identities and the homepage typewriter implementation.

## Initial scope

One-time and recurring execution of saved Apps and unattended Workflows, scoped to the current
workspace. No scheduled raw AI prompts, event triggers, cloud
scheduler or implicit notification delivery. Workrun desktop must remain open;
missed occurrences are not replayed. Pausing future scheduling does not stop an
existing run. Batch requests are clarified and managed one task per confirmation.

## Validation

- Rust scheduling tests cover the shared dispatch recipe, transaction receipts,
  optimistic conflicts, workspace isolation, task lifecycle, real run errors,
  independent tool boundaries and scripted model exchanges.
- Component tests cover unified discovery, result links, explicit confirmation,
  persisted questions and conflict feedback.
- WebKit tests check desktop light/dark and narrow-screen question layouts.
- A real-provider conversation remains a manual integration check using a model
  configured in Workrun; automated tests do not make paid provider calls.

One-time schedules use `schedule_kind=once` and an absolute UTC `run_at`, with an IANA timezone for presentation and local date editing. `ScheduleTiming` validates timing and `ScheduleDispatcher` atomically claims occurrences. Claiming disables a one-time task and records its terminal reason separately from the execution result. Startup recovery marks overdue enabled one-time tasks missed without running them. Rescheduling clears terminal state; pause/resume cannot revive a finished task. Five-field Cron remains exclusively for recurring schedules.
