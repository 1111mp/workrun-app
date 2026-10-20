---
name: workflow-planning
description: Form a reviewable, resource-grounded workflow plan through iterative user clarification.
---

Use read_skill(name=workrun-capabilities) for Workrun's native capability map and
reference/discovery paths. Read relevant details through get_workflow_reference;
resource IDs and availability come from discovery, not the static overview.

Use the overview's capability-selection and observable-check guidance when the task
involves files, exact operations or external effects. Explain the execution method
and task evidence in existing plan fields; do not add a mapping protocol or freeze
a node topology. A representative input helps plan future runs, not precompute them.

Plan the desired outcome before producing a graph. Separate user-facing decisions from implementation choices. Inspect real inputs when structure matters. Discover exact resource IDs and only relevant node references. Reuse suitable capabilities when they fit; otherwise plan base nodes with explicit responsibilities and data handoffs.

Before saving the proposal, use the existing fields to make its feasibility reviewable:

- steps.description: what operation consumes which input and produces which result;
  distinguish execution from interpretation when it matters to correctness.
- steps.configuration_notes: how the operation will actually execute, relevant
  format/environment limits, and how later work can inspect its results. Read the
  relevant native guide and selected resource contracts before claiming support.
- dependencies: actual IDs committed to that method. Native base-node execution
  need not invent a tool dependency; an available tool still needs node selection.
- acceptance_criteria: observable outcome properties and appropriate failure behavior,
  including reuse with changed inputs. Include both creation requirements and task
  fulfillment, with runtime checks explicitly pending until authorized execution.

A lightweight language task need not gain extra nodes or tools. For exact processing,
"the model reads and calculates" is not an executable method. When feasible, design
checks using native capabilities so invalid input or inconsistent output is exposed
rather than turned into a successful report. Choose checks proportional to the task;
no fixed graph, verification node or additional plan field is required.

Save `document_json` as the JSON serialization of this interface (node_types may be omitted; other arrays are required; target_id and artifact_id may be null or omitted). base_version is the current native plan version, or 0 if absent:

```typescript
interface WorkflowPlan {
  goal: string;
  summary: string; // Short user-facing approach.
  inputs: { name: string; description: string; artifact_id?: string | null }[];
  outputs: string[];
  steps: {
    title: string;
    description: string; // Responsibility, input/output handoff, effects.
    node_types?: string[]; // Optional supported-node suggestions, not a fixed graph. May be empty.
    dependencies: {
      kind: 'model' | 'tool' | 'skill' | 'workflow' | 'app';
      id: string; // Exact discovered ID of a resource committed to this approach.
      purpose: string;
    }[];
    configuration_notes: string; // Proposed choices, evidence and tradeoffs; no hidden reasoning.
  }[];
  constraints: string[];
  assumptions: string[];
  questions: string[]; // Only unanswered material questions, not optional details.
  acceptance_criteria: string[]; // Observable tests of task fulfillment.
  target_id?: string | null; // Existing Workflow UUID only for an authorized revision.
}
```

The plan is a proposal, never proof of user approval or execution. Revise by saving a new version after incorporating answers/corrections. Review the latest version on a stale-write error. Do not carry approval across versions. A ready plan still needs the user's subsequent decision before configuration. When requirements cannot be met, state the capability gap and feasible alternatives instead of inventing resources or silently changing the goal.

The approved goal, inputs, outputs, constraints and material processing decisions
guide creation. Node suggestions and routine configuration details can be resolved
by the author from native contracts. Use dependencies for committed resources;
put tentative resource/node alternatives in configuration_notes. User confirmation
reviews the intended approach without requiring a finished technical graph.
