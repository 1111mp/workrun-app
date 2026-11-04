---
title: Schedule Apps and Workflows
description: Create and manage one-time or recurring App and Workflow schedules through conversation, with explicit time zones.
---

Open **Scheduled tasks** in the sidebar to arrange App or Workflow runs through conversation. You can create one-time or recurring tasks without starting each run manually. They are stored locally and resume scheduling when Workrun is opened again.

> Schedules run only while the Workrun desktop app is open. They are not a hosted background service; keep Workrun running for time-critical automation.

## Start from Scheduled tasks

![Scheduled tasks entry page with the sidebar entry, conversation composer, and Task list tab.](/media/schedules/03-scheduled-tasks-entry.png)

The screenshots below show the Chinese interface.

### Arrange a task through conversation

1. Select **Scheduled tasks** in the sidebar and choose a configured model.
2. Describe the App or Workflow, its timing, and the required inputs. For example: “Run the project report Workflow every Friday at 5 PM in Asia/Shanghai,” or “Run the data sync App once on November 10, 2026 at 9 AM in Asia/Shanghai.” Use a future date that matches your needs.
3. Answer any follow-up questions about the target, timing, or inputs.
4. Review the confirmation card: check the target, run inputs, time zone, and execution time. Recurring tasks also preview upcoming occurrences.
5. Select **Create task** and wait for **Saved** before treating the task as scheduled. To make adjustments, continue the conversation and confirm the revised proposal.

An assistant reply or a pending proposal does not mean a task has been saved. Stopping a reply does not undo changes you already confirmed.

![A conversation scheduling the User Info App daily at 10 AM, with a saved confirmation card and an active task card.](/media/schedules/04-create-schedule-conversation.png)

This example asks to run the User Info App every day at 10 AM. After confirmation, the task runs at 10:00 in `Asia/Shanghai`. The saved task card shows its next execution time; select **View task** to inspect its details.

### Inspect and manage scheduled tasks

Switch to **Task list** to search tasks and filter by **All tasks**, **Active**, **Paused**, or **Needs attention**. Open a task to inspect its timing, run inputs, and recent runs; select **View result** to inspect a run.

You can also continue the conversation: “Move the project report to Fridays at 6 PM,” “Pause the data sync task,” or “Show the latest execution results.” Changes, pauses, resumptions, and deletions proposed through conversation require you to review and confirm the card. Task details also provide editing, pause, resume, and delete controls.

Deleting a task stops future triggers and retains existing run records. Pausing a task does not stop a run that has already started. Use **Conversation history** to revisit an earlier conversation, or select **Scheduled tasks** in the sidebar again to start a new one.

## One-time and recurring tasks

- **One-time tasks** run once at a specified date and time. Check the full date, time, and time zone before confirming; inspect the task's status and run records afterward.
- **Recurring tasks** repeat according to a frequency or Cron rule and show their next run time. Pause a task to suspend future runs.

One-time tasks do not require Cron. The App and Workflow settings below configure recurring tasks.

## Configure recurring tasks from an App or Workflow

### App schedule

1. Open **Apps** and select the App to automate.
2. In **Schedules**, select **New schedule**.
3. Give it a recognizable name, choose a preset frequency or **Custom Cron**, then choose a time zone.
4. Check the preview and select **Save schedule**.

<video controls preload="metadata" poster="/media/schedules/01-create-and-trigger-app-schedule.png">
  <source src="/media/schedules/01-create-and-trigger-app-schedule.mp4" type="video/mp4" />
  Your browser does not support MP4 video playback. Download the video from the documentation media folder instead.
</video>

This recording creates an App schedule, confirms its configuration, and shows the scheduled run being triggered.

### Workflow schedule

1. Open the Workflow editor and find **Automation** in its settings.
2. Select **New schedule**.
3. Provide values for the Workflow inputs. Required inputs must be filled in before the schedule can be saved.
4. Choose its frequency, time (or a custom Cron expression), and time zone; review the next occurrences; then save.

The schedule list shows whether each schedule is active and its next run in the chosen time zone. Use its switch to pause or resume it, the pencil button to edit it, and the delete button to remove it. Deletion cannot be undone.

<video controls preload="metadata" poster="/media/schedules/02-create-and-trigger-workflow-schedule.png">
  <source src="/media/schedules/02-create-and-trigger-workflow-schedule.mp4" type="video/mp4" />
  Your browser does not support MP4 video playback. Download the video from the documentation media folder instead.
</video>

This recording creates a Workflow schedule, supplies its scheduled inputs, and shows the run after it is triggered.

## Choose a frequency or write Cron

The **Every day**, **Every weekday**, and **Every week** choices build the expression for you. Choose **Custom Cron** when you need a different pattern.

Recurring tasks accept exactly five space-separated Cron fields:

| Position | Field        | Allowed example      |
| -------- | ------------ | -------------------- |
| 1        | minute       | `0`, `*/15`, `5,35`  |
| 2        | hour         | `9`, `8-18`, `*/2`   |
| 3        | day of month | `1`, `1-7`, `*/2`    |
| 4        | month        | `1`, `1,4,7,10`, `*` |
| 5        | weekday      | `1-5`, `1`, `*`      |

Use `*` for every value, `,` for a list, `-` for a range, and `/` for a step. Weekday `1` is Monday, so `1-5` means Monday through Friday. Seconds are not supported.

| Intent                               | Cron expression |
| ------------------------------------ | --------------- |
| 09:00 every day                      | `0 9 * * *`     |
| 09:30 on weekdays                    | `30 9 * * 1-5`  |
| Every 15 minutes                     | `*/15 * * * *`  |
| 18:00 on the first day of each month | `0 18 1 * *`    |

The expression is interpreted in the schedule's IANA time zone, such as `Asia/Shanghai` or `America/New_York`, rather than the time zone where a run is viewed. The editor validates both the expression and the time zone and previews the next three occurrences. This is especially useful around daylight-saving changes.

## App and Workflow behavior

An App schedule runs the saved App target. Use it for independent code tasks such as periodic data collection or cleanup.

A Workflow schedule also saves its configured input and uses those values on every run. Local Workflow schedules resolve the latest saved version of the Workflow when they dispatch. In Team mode, select a published release: the schedule pins that published version, so later edits do not change the scheduled behavior.

Scheduled Workflows must be able to complete unattended. Workrun rejects a schedule for a Workflow containing **Human Review** or **Ask User Question** nodes. Remove those nodes before scheduling the Workflow; routing around them is not sufficient. If a previously valid local Workflow is later deleted or becomes invalid, Workrun pauses its schedule and records the error so it does not keep attempting runs.

## What happens at run time

- Schedule changes take effect immediately; the scheduler wakes after you save, edit, pause, resume, or delete a schedule.
- A due run is recorded in normal run history, so use the run panel and traces to inspect its output or failure.
- Workrun prevents overlapping runs for the same App or Workflow. If that target is already queued, running, or waiting for input, it records the occurrence as skipped and advances to the next matching time.
- On startup, recurring occurrences missed while Workrun was closed are advanced to the next future occurrence. Workrun does not replay a backlog of missed runs, and missed one-time tasks are not replayed either.

For schedules that perform writes, sends, or other external side effects, make the App or Workflow safe to run more than once and choose a frequency longer than its usual execution time. Review the target's permissions and test it manually before enabling the schedule.
