# Native resource configuration

Configure ordinary Workflow fields after discovering the resource contracts. These
notes explain existing controls; task intent determines which nodes and resources
fit. Read only relevant node guides and exact schemas as needed.

## Resources, selection and calls

| Resource | Discovery | Workflow configuration |
| --- | --- | --- |
| Model | list_authoring_resources(kind=models) | modelProfileId on Agent/CodeAct |
| Tool App / MCP tool | list_workspace_tools; exact tool_id returns schemas/policy | toolIds; optional toolStateBindings on Agent/CodeAct |
| Personal Skill | list_workspace_skills; read_workspace_skill for instructions/references | agent.skillRefs with source=personal and discovered name |
| Workflow App | list_capabilities | process.processNodeId: native App ID, without app: prefix |

Workspace tool/Skill search currently matches query text against names,
descriptions and tags; it is not semantic capability matching. Follow nextCursor
for additional results. If a narrow query finds nothing, try relevant alternatives
or inspect summaries without a query before declaring a capability unavailable.
An exact tool_id lookup supplies the full contract; a summary alone is insufficient.
Skill trigger=true requires explicit user @name invocation before applying it.

The tool ID selects an installed dependency. Its name identifies the callable
function, and inputSchema identifies its arguments; these values are not
interchangeable. Use the discovered outputSchema to understand tool results.

Without Skills, Agent attaches its selected tools directly. With Skills, the node
uses SkillToolset: discovery/loading exposes the declaring Skill's tools lazily.
Every declared tool must also be selected in toolIds. If any selected Skills have
nonempty allowedTools lists, the effective set is the union of those lists within
node selection. Inspect declarations before selecting a Skill; an unrelated Skill
is not a way to attach extra tools. Authoring-time Skill reading does not activate
it in the executing node. CodeAct currently supports toolIds but not skillRefs.

Native tool policy, arguments, limits and confirmation handling still apply. A
resource description or Skill cannot grant access or establish service availability.

## Native state paths and outputs

A node reads its scoped visible state. Producer outputs are private by default.
For private sharing, configure producer.state.access.readers with consumer IDs;
the consumer sees the original key in its flat scoped input. Namespace ownership
is internal: there is no automatic producerId.key alias. Duplicate keys from visible
sources raise InputKeyConflict. For global sharing, publish the selected producer
keys through state.globalKeys; consumers see key. Edges establish execution order.
Use the sharing appropriate to the task; neither form creates an output value.

Agent outputSchema makes top-level object properties into private state keys;
outputKey instead stores the complete final text under one key. Select one of
these output modes. Instructions should describe the actual requested behavior.
A tool result stays in the tool/model exchange until the node returns its output;
state.globalKeys does not select a property from an arbitrary tool response.

For a tool argument, toolStateBindings uses the selected tool ID, a declared
argumentPath and an accessible statePath. The model's call must already include
that argument slot; binding replaces its value, not the entire call. A private
producer result named result uses statePath=result (or result.field for a nested
property), after access is granted. Refer to topic=state for
original-value access through rawReaders and for redacted values.

Workflow Apps receive the visible input object. Their input/output contract uses
actual field names; processNodeId, an edge or globalKeys does not rename fields.
Discover the contract and make the required inputs available. Publish actual App
output keys or share its private namespace for subsequent work.

## Workflow result export

Node outputs and Workflow outputs are different contracts. The assistant exports
only global keys declared by settings.outputSchema (or the native capability output
schema). Publish the actual required final keys through producer.state.globalKeys
and declare matching Workflow output fields. A private result or a value mentioned
only in a report is not automatically exported. Required fields must exist and
match their output types; large inline outputs should use real ArtifactRefs.
Native output validation checks that contract, not the factual truth of its values.

## Files and CodeAct

Ordinary text, numbers, objects and JSON strings pass through native scoped state.
A downstream Agent can use their visible keys in its instruction without
attachmentPaths. Publish with globalKeys or grant namespace readers as needed;
an execution edge alone does not grant visibility. attachmentPaths is exclusively
for file references, not a general input mapping or a request to parse JSON text.

Agent attachmentPaths reads ArtifactRefs from visible state and includes supported
file contents as model input. It does not attach a reader/calculator tool. Read the
Agent guide for format/provider/size limits and use a capable executor when needed.

CodeAct maps visible files through /artifacts/manifest.json, an array of
{reference:{id,name,...},path} entries. Match the actual input reference ID and read
entry.path; no attachmentPaths is needed. Use only supported Python modules/tools.
Read CodeAct node details (topic=nodes, node_types=["codeact_agent"]) for the linked
runtime language/module and supported
OS/path-operation briefing. It describes the standard virtual workspace, not host
permissions or a complete Python API inventory. Do not assume arbitrary library
or method availability.
Write deliverables under /outputs; Workrun imports them and writes real references
into the node's artifacts state key. final_result.value supplies other named output
fields; publish/share result and artifacts using normal state configuration.
CodeAct has no Agent outputKey; an optional outputSchema validates its final value.
Explicit mounts/environment are additional authorized configuration, not defaults.

## Examples and verification

get_workflow_reference(topic=examples) lists summaries. Supply node_types=["agent"],
["codeact_agent"] or ["process"] to read matching ordinary Workflow documents.
These show configuration syntax, not a required topology or business process.

- Agent example assumes a discovered text-transform tool accepts {text:string}
  and returns the desired text, and a personal Skill declares that same tool ID.
  Resolve all model/tool/Skill placeholders against actual contracts. source_file
  is an optional attachment; its format must be supported by the chosen provider.
- CodeAct example demonstrates visible file access, native final_result and global
  result/artifact publication. It contains an instruction, not a preexecuted script.
- Process example assumes an installed Workflow App consumes source_text and
  produces result. Substitute the actual contract and App ID; use appRef as the
  node guide requires for an authorized team release.

The examples retain discovery placeholders. Local node-schema, document storage
and editor round-trip tests do not establish installed dependencies or successful
model/App execution. After resolving resources, submit to save_workflow_draft:
it runs the native compiler before writing and returns issues for repair. Use
validate_workflow_draft separately only for a validation-only review. Saving and
authorized execution remain separate; task correctness needs actual result evidence.
