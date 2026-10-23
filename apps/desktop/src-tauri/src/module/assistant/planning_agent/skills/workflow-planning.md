---
name: workflow-planning
description: Propose a feasible Workflow outcome and resolve material uncertainty.
---

First check whether a saved Workflow already meets the requested outcome. A request
to make work reusable does not require a new definition or plan in each conversation.
For a matching inspected contract, return reuse_available as described in the role
instructions. Use the proposal format below only for necessary creation or revision.

Describe the outcome and material decisions the user needs to review. Discover the
capabilities needed to establish feasibility; do not exhaust every catalog. Node
configuration belongs to the author, not this proposal. Use the existing fields:

- steps.description: responsibilities, important processing rules and outputs. Steps
  describe work, not canvas nodes; omit routine Start/End and wiring details.
- steps.configuration_notes: only capability limits or choices affecting the outcome;
  use an empty string when there is nothing material to explain.
- dependencies: exact discovered resources committed to the approach, not alternatives.
- acceptance_criteria: observable task outcomes, including relevant failure/reuse
  behavior. Execution-dependent checks remain pending until an authorized run.

Keep observed facts, agreed rules and assumptions distinct. Ask only unresolved
questions that materially affect the requested outcome; hypothetical future features
are not prerequisites. Do not add optional inputs or file deliverables merely because
they are possible. Revisions incorporate feedback without redoing settled decisions
or unrelated discovery.

Save `document_json` as the JSON serialization of this interface (node_types may be omitted; other arrays are required; target_id and artifact_id may be null or omitted). base_version is the current native plan version, or 0 if absent:

```typescript
interface WorkflowPlan {
  goal: string;
  summary: string; // Short user-facing approach.
  inputs: { name: string; description: string; artifact_id?: string | null }[];
  outputs: string[];
  steps: {
    title: string;
    description: string; // Responsibility, important rules and outputs.
    node_types?: string[]; // Optional supported-node suggestions, not a fixed graph. May be empty.
    dependencies: {
      kind: 'model' | 'tool' | 'skill' | 'workflow' | 'app';
      id: string; // Exact discovered ID of a resource committed to this approach.
      purpose: string;
    }[];
    configuration_notes: string; // Material capability limits/choices, or empty.
  }[];
  constraints: string[];
  assumptions: string[];
  questions: string[]; // Only unanswered material questions, not optional details.
  acceptance_criteria: string[]; // Observable tests of task fulfillment.
  target_id?: string | null; // Existing Workflow UUID only for an authorized revision.
}
```

Save feedback as a new revision; read the latest version after a stale-write error.
Approved outcomes and material rules guide creation; node hints do not fix topology.
Disclose capability gaps. A ready plan still requires user confirmation.
