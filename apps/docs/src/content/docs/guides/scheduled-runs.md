---
title: Schedule Apps and Workflows
description: Run a local App or Workflow on a durable, timezone-aware Cron schedule.
---

Schedules let Workrun start an App or Workflow at defined times without requiring you to start each run manually. They are stored locally and resume scheduling when Workrun is opened again.

> Schedules run only while the Workrun desktop app is open. They are not a hosted background service; keep Workrun running for time-critical automation.

## Create and manage a schedule

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

Workrun accepts exactly five space-separated Cron fields:

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
- On startup, any occurrences missed while Workrun was closed are advanced to the next future occurrence. Workrun does not replay a backlog of missed runs.

For schedules that perform writes, sends, or other external side effects, make the App or Workflow safe to run more than once and choose a frequency longer than its usual execution time. Review the target's permissions and test it manually before enabling the schedule.
