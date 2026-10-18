# State, data flow and resources

Run inputs must be an object; each top-level key enters global state. Node outputs are private by default. Edges control execution order, not automatic transfer of private outputs.

Publish explicit producer keys with data.state.globalKeys. For example, declare summary in an agent outputSchema and state.globalKeys:["summary"] so downstream nodes can read it globally. outputKey stores complete final text and is mutually exclusive with outputSchema. Structured output top-level fields become private keys directly; do not add a result wrapper.

For private sharing, list consumer IDs in the producer's state.access.readers. Add consumers to rawReaders only when they need original unredacted data. rawReaders must be a subset of readers. Neither list may reference the producer itself, nonexistent nodes, start, end or layout nodes. state.sensitiveFields uses dotted paths. Published global keys cannot use the reserved workflow. prefix.

Visible state flattens global fields and represents accessible private fields as nodeId.key. Path lookup checks an exact key before traversing dotted segments. Do not invent paths such as nodes.nodeId.result. Agent prompts receive visible state only; authorized original values may be bound at the tool execution boundary.

Agent/CodeAct toolStateBindings are [{toolId,argumentPath,statePath}]. argumentPath is a dotted tool-argument path; statePath is an accessible state path. Reference a selected toolId and its actual argument schema. The runtime only replaces argument positions already present in the model's call; it does not expand the call automatically.

Process Apps receive visible inputs and produce private output keys. Reuse their exact input/output schemas and publish downstream keys with globalKeys. Subworkflows receive parent-visible inputs and return only declared outputSchema global keys; the parent node must publish them again as needed.

Parallel branches cannot assume each other's outputs exist. Design dependencies and joins explicitly; multiple incoming edges do not imply identical consumer semantics. Validate a clear serial path before introducing concurrency.

Files must use runtime ArtifactRef values. Never fabricate local paths, content references or base64 state. attachmentPaths selects references from visible state. CodeAct reads authorized files through /artifacts/manifest.json and writes artifacts to /outputs. Keep large content in artifacts rather than inline JSON.

Main-agent execute_capability bindings connect user messages or prior runs to a new run. Internal state/toolStateBindings connect nodes within that graph; these are separate layers.
