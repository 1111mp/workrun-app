---
title: Build your first workflow
description: Combine a Process, Agent, and branches into automation you can explain.
---

Use “customer feedback routing” as an example. Python first performs deterministic cleanup, an Agent classifies and recommends an action, and a rule decides whether a person must review it. This expands the minimal Agent from the [quickstart](/getting-started/quickstart/) into a production-shaped flow.

```text
Start → Prepare data (Process) → Classify and recommend (Agent) → High risk?
                                                          ├─ Yes → Human Review → End
                                                          └─ No ─────────────────→ End
```

## Define the state contract first

Before connecting the canvas, list the fields every step produces and consumes.

| Node | Reads | Writes | Publish to global state? |
| --- | --- | --- | --- |
| Start | — | `feedback` | Yes; later nodes need it. |
| Prepare data (Process) | `feedback` | `normalized_feedback`, `is_high_risk` | Yes; the Agent and branch need them. |
| Classify and recommend (Agent) | `normalized_feedback` | `category`, `priority`, `recommendation` | Yes; review and End need them. |
| Human Review | `recommendation` | `approved` | Yes; the branch or End may need it. |

On nodes that produce output, enter these keys in **Publish to global state → Published output keys**, separated by commas. Output is node-private by default; downstream nodes cannot assume they can read it until it is published and they have been granted read access.

## Assign responsibilities

1. **Process:** read input, normalize fields, apply fixed rules, or query internal systems.
2. **Agent:** make semantic judgments and return fixed fields such as `category`, `priority`, and `recommendation`.
3. **If/Else or Switch:** branch only on declared state fields.
4. **Human Review:** give a person decisions that affect customers, funds, permissions, or public content.

## Configure the branch and review

1. Set an **If/Else** condition such as `is_high_risk == true || priority == "high"`.
2. Connect the “yes” output to **Human Review**, and the “no” output to End.
3. In **Review request**, set the content key to `recommendation` and context keys to `category, priority, normalized_feedback`.
4. Enable **Allow editing** if the reviewer should be able to rewrite the recommendation.
5. Connect both the approved and rejected outputs. Do not silently end a rejection; route it to more information, a rewritten recommendation, or an explicit terminal node.

> **Media placeholder · screenshot `workflows/01-state-publication.png`**  
> Show the Process node’s “Publish to global state” section with multiple output keys entered. Explain that producing output and exposing it to the workflow are separate actions.

> **Media placeholder · video `workflows/02-branch-and-review.mp4` (45–60 seconds)**  
> Add If/Else, enter the condition, configure Human Review, then run to a pause and approve it to resume.

## Design notes

- Make each node do one describable job.
- Define node output before writing prompts and code.
- Use readable state field names rather than stuffing whole documents into every node.
- Put side-effecting operations after review and enable human confirmation for Agent tool calls.

Run three examples before moving to evaluation: ordinary feedback, clearly high-risk feedback, and feedback with missing information. They become your first [evaluation cases](/quality/evaluations/).
