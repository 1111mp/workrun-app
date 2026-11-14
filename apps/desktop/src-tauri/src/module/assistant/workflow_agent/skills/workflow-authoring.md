---
name: workflow-authoring
description: Configure and save native Workflows from approved plans.
---
1. node_contracts supplies complete native data schemas for plan-suggested and existing
   nodes, including Start/End. Use them directly; hints are not a mandatory topology.
   Read another selected node only if choosing a type not supplied. Use references
   for a specific unanswered question, not as a checklist before saving. Do not read
   examples/configuration to reconfirm supplied fields; native saving validates them.
2. Reuse supplied native IDs, including preferred_model_profile_id unless unsuitable.
   Native saving validates model configuration; do not enumerate models merely to
   reconfirm the supplied ID. Use model_id for an exact lookup if it is in doubt.
   Discover missing models, tools, Skills or Workflow/App contracts with their tools;
   inspect selected exact contracts. Never invent IDs, paths, credentials or access.
   Discovery is not availability, and reading a Skill does not attach dependencies.
3. Submit {settings,nodes,edges}. settings has name, mode (task/chat), optional
   description and inputSchema/outputSchema:{fields:[{id,key,label,type,required}]}.
   Field types: string, textarea, number, boolean, file, files; keys are unique and
   cannot start with workflow. Node:{id,type,data,position:{x,y}}; edge:{id,source,
   target,sourceHandle?}. Use unique IDs and only the selected contract's handles.
   Exactly one start and at least one end; start connects to an executable node.
   Run input top-level keys enter global state. Node outputs are private unless
   published by data.state.globalKeys; edges establish order, not private sharing.
   Consumers read visible fields directly, without an invented node-ID prefix.
   Schemas and End do not produce values. Agent/CodeAct data.name names the node;
   their outputSchema is JSON text, not an object. CodeAct final_result.value is an
   object of named output fields. State is supplied as model-visible input, not
   automatically injected Python variables; scripts use actual visible input values.
   Returning final_result.value publishes its named fields through state.globalKeys;
   declare matching settings.outputSchema fields to export the Workflow result.
   A plain value computation needs neither filesystem APIs nor a second publication
   tool. Selected examples demonstrate syntax; they do not define a required topology. Use format/state for private access, redaction,
   subworkflow wiring or other unresolved details; codeact-runtime for exact file,
   tool or language APIs beyond basic expressions. Never assume full Python support.
   Group independent reads and wait before dependent work.
4. Call save_workflow_draft(document_json=JSON text), which validates before writing.
   Repair errors and retry only on failure. Separate validate_workflow_draft is for
   explicit validation-only review. Saving grants neither execution nor publication.
