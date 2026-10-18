# Workflow document format

Pass document_json as a JSON-encoded string containing the document, not prose, DSL code or an array of tool calls. The document contains settings, nodes and edges, with optional viewport. Native delegation supplies a stable workflow UUID. Creation adds one definition to the ordinary workflow catalog; an authorized revision updates its specified target. Historical execution snapshots remain immutable.

settings supports name (required, nonempty), description, mode (task/chat), inputSchema, outputSchema and sessionStateFields.
inputSchema/outputSchema use {fields:[{id,key,label,type,required,description?}]}. Supported field types: string, textarea, number, boolean, file, files. Keys must be nonempty and unique, without the reserved workflow. prefix. Legacy output fields may have only key; new workflows should declare complete types and required flags. outputSchema does not generate results: nodes must publish corresponding globalKeys.

inputSchema may include rawReaders (node IDs permitted to read original input) and sensitiveFields (input paths to hide). Agent prompts receive visible state only; authorized original values are retrieved at the tool boundary. Existing chat services manage implicit chat input and sessionStateFields. A single main-agent capability execution is not a persistent chat session.

Node shape: {id,type,data,position:{x,y}}. IDs must be unique; prefer letters, numbers and underscores. Discover supported types from the native index. Position affects layout only. Groups can use React Flow parentId, extent and style; the group itself cannot have edges.
Edge shape: {id,source,target,sourceHandle?}. sourceHandle is only for conditional routing. Stable edge IDs are recommended; execution uses endpoints and handles.
Exactly one start and at least one end are required. start must first connect to an executable node, never directly to end.
Do not invent outputMapping, next, steps, expression nodes, loop nodes, dynamic tools or internal runtime metadata.

## Choosing a graph

Derive topology, field names, branch conditions and outputs from the delegated task.
The format does not prescribe a business process or a preferred node sequence.
Use the index to choose appropriate executable nodes, then read only their detailed
contracts. Node examples demonstrate configuration syntax; replace all resource
placeholders and task semantics before validation. Do not copy an example as a plan.

Successful validation means the current contract and compiler accepted the document. It does not prove execution, credential availability, service reachability or goal fulfillment.
