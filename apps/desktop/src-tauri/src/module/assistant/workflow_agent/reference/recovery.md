# Execution, human participation, recovery and compensation

Create and validate a graph, then submit a valid draft to the existing executor. Execution still requires current user intent, input bindings, workspace permissions and native policy. Saving or compiling a draft neither grants execution permission nor proves business success.

Native run-center actions handle human reviews, user questions and tool confirmations. Never inject internal approved/answer/toolConfirmation state to bypass participation.

The native run ID is persisted before dispatch. On timeout, disconnection or unknown outcome, inspect the original run before creating another execution. Process operations may have side effects even if success was not persisted and may need human reconciliation. Remote A2A tasks use existing task IDs for inspection, cancellation and reconciliation. Parent/child interruptions resume through native child execution chains.

Side-effect declarations are not facts the model can verify. Never label unknown operations read_only just to pass validation. Process/Remote use data.compensation. Agent toolCompensations is keyed by selected tool ID. CodeAct currently does not support these tool compensation declarations. Subworkflow compensation must be delegated.

Modes: unspecified, read_only, irreversible (nonempty reason), compensatable (action, bindings, idempotency), delegated (subworkflows only). Read get_workflow_reference(topic=compensation) for full nested declarations; use topic=execution-recovery for native recovery details. Preserve unspecified when no known compensation exists; never invent reverse operations.

Compensatable action kinds are app_entry, tool (toolId), process (processNodeId) and remote_agent (url, optional authentication). Each binding uses from literal/value, input/pointer or output/pointer. idempotency specifies keyArgument and a real contract. All references must come from authorized resources.

Compilation checks current metadata, structure and configuration. Some nodes need configured models, tools, credentials or local resources at compile time. Validation does not call models, execute Apps, access A2A services or install dependencies. CodeAct compilation constructs a temporary local runtime; this does not prove script execution succeeded.

Final answers must use actual execution receipts, outputs and artifacts. Distinguish draft creation, successful compilation, execution completion and fulfillment of the user's goal.
