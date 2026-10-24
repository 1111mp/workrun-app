# Connections, conditions and control flow

Edge source/target must exist. end has no outgoing edges; start cannot be a target; group has no edges. Ordinary nodes do not accept sourceHandle.

if_else requires both data.conditions.true.condition and false.condition. They are independent conditions, evaluated true first, then false; neither matching ends execution. sourceHandle is true or false, at most one edge per handle. Explicitly connect both branches.

switch uses data.cases entries {id,label,condition}, selecting the first matching case in array order, or default otherwise. Handles are case:<id> and default. defaultCase.condition is descriptive only.

Condition syntax is a valid field path tested for truthiness, or one comparison against a literal: == != >= <= > <. Literals support JSON numbers, booleans, null, double-quoted strings and compatible single-quoted strings. No and/or, grouped expressions, calls, assignments, Python or JavaScript. Syntax examples: flag == true; flag; status == "ready". Have an agent/process/CodeAct produce a boolean or classification for complex decisions, then route on that field.

human_review interrupts execution and routes via approved/rejected. ask_user_question interrupts execution and routes via option:<configured option ID>. Real user actions supply decisions through native resume handling. Never fabricate reserved approval or answer keys through initialState.

terminate stops the current workflow and its parents, unlike ordinary end. It does not undo completed business operations.

There is no standalone loop/retry base node. CodeAct maxIterations bounds the node's internal model loop, not an arbitrary workflow loop. The compiler and graph runner retain execution limits. Do not invent unbounded back edges for retries, especially with side effects; read recovery and use native recovery mechanisms.
