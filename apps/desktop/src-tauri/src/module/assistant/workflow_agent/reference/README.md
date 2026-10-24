# Progressive workflow authoring reference

Planning and Workflow authoring specialists read this reference through
get_workflow_reference. The main agent delegates an authorized outcome; it does not
load node manuals or construct graphs itself. All three roles can read the same
optional workrun-capabilities Skill, packaged at reference/workrun-capabilities.md.
The overview supplies capability boundaries and discovery paths, not installed IDs.

The specialist first reads `workflow-authoring`, then requests the format/state/routing
reference and resource catalog as needed. The node index contains concise capability
summaries. Detailed node skills and TypeScript configuration views are loaded only for
nodes being considered. JSON Schema and the native compiler remain authoritative;
TypeScript interfaces are a reading aid, not a replacement validator.

Node documentation is English. Source paths in generated references are maintenance
pointers, not files the packaged model is expected to access. Every operational detail
needed by the model must exist in the shipped reference/tool response.

## Authoring lifecycle

1. Receive goal, expected outputs, acceptance criteria, assumptions and optional target UUID.
2. Inspect relevant authorized inputs and discover actual models, Apps and workflows.
3. Load relevant node skills, design the graph and configure task-specific behavior.
4. Validate through schema and the native compiler; repair actionable errors.
5. Save a valid normal workspace workflow and return its native UUID and validation result.

Missing essential resources or ambiguous business requirements return questions to the
main agent. The specialist cannot dispatch a workflow. The main agent decides the next
step using the user's execution authorization and the actual native save result.

A new graph uses its delegation UUID, making repeated saves idempotent. A revision
retains the specified target UUID. Saved workflows use the full ordinary editor and
execution paths; unreleased workflows display Draft. Retrying execution resolves the
current definition. Historical snapshots do not overwrite the editable graph.

Validation does not execute nodes, install resources, publish, or prove business
correctness. Limits include 256KB input, 100 nodes and 200 edges. Model steps and the
parent phase timeout also bound authoring. Runtime output/permission errors must be
reported honestly; they do not grant editing or another execution automatically.

## Generation and packaging

```sh
pnpm --dir apps/desktop workflow:generate
pnpm --dir apps/desktop workflow:check
```

`generate-workflow-reference.mjs` generates the node index, 13 independent node skills
and TypeScript views from the shared contract. It also packages the shared capability
overview for all three role catalogs. It copies these and general agent/skill
resources into `src-tauri/resources/assistant/`. Update source files, not generated
copies. Node parser changes must also update contracts and meaningful regressions.

`prebuild` runs generation; Rust `build.rs` rejects missing/stale resources. Development
reads the generated resource directory. Packaged builds read `resources/assistant/`
under Tauri's resource directory. Reference bodies are not embedded with `include_str!`.
Missing resources produce an explicit error.

## Tests

Authoring tests exercise invalid-graph repair, isolated child tools, save-only tasks,
stable native identity and real rule-graph compilation/execution in temporary storage.
Optional provider tests use the configured model; they do not install workflows into
the user's catalogue. No sample-specific formula or reporting instruction belongs in
the product's general prompts.

## Native configuration examples

`configuration.md` describes native resource selection, Skill activation, tool/state
bindings and file/output behavior. `configuration-examples.json` contains ordinary
Workflow documents using discovery placeholders; it is packaged with the guides.
`get_workflow_reference(topic=examples)` returns summaries, and selected node_types
return matching documents. These are syntax examples, not executable installed
resources. Local tests cover node schemas, native catalog storage, editor document
round-tripping, private state/tool bindings and Monty file export with global state.
Full compiler/provider/App execution requires resolved real resources and is not
established by placeholder validation.
