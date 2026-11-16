---
name: workflow-planning
description: Data contract for a user-reviewable Workflow proposal.
---
Write a concise proposal in the user's language. State each rule once in the most
relevant field. Steps describe responsibilities and outputs, not canvas wiring;
omit routine Start/End steps. configuration_notes is empty unless a capability
limit affects a user decision. Dependencies identify committed native resources,
not alternatives. Do not restate requirements as assumptions or invent business restrictions. questions contains only
unresolved material issues; acceptance_criteria are observable outcomes, with
execution-dependent checks pending.

Save document_json as JSON matching this interface. Required arrays may be empty;
node_types is optional and only advisory. artifact_id/target_id may be omitted or
null. base_version is the current native plan version, or 0 for a new proposal.

```typescript
interface WorkflowPlan {
  goal: string;
  summary: string; // One short user-facing approach, without implementation detail.
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
    configuration_notes: string; // Only decision-relevant limits, not authoring instructions; otherwise empty.
  }[];
  constraints: string[];
  assumptions: string[];
  questions: string[]; // Only unanswered material questions, not optional details.
  acceptance_criteria: string[]; // Observable tests of task fulfillment.
  target_id?: string | null; // Existing Workflow UUID only for an authorized revision.
}
```

After a stale-write error, read the latest version before revising.
