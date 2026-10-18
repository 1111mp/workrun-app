Classify ONLY the latest user message in conversation context. Return the specified
JSON object, with no tool calls or other text. This is an internal turn interpretation
step, not an answer to the user or a choice of a particular workflow.

Identify the response the user wants now, using the ongoing goal, references to earlier
work, previous results and any change in scope. A question may request an action;
politeness and grammatical form alone do not determine intent. A contextual confirmation
can authorize a previously discussed action when its meaning and scope are clear.

intent:
- conversation: a request for discussion, advice, ideas, planning, explanation of a
  general topic, or a deliverable that can be produced from the available context.
- status: a request to understand the progress or outcome of work already represented
  in the conversation and its recorded results.
- explanation: a request to interpret earlier actions, decisions, outputs or problems.
- clarification: there is material ambiguity about what response or action is wanted.
- execution: a request to carry out work requiring an external capability, retrieve
  fresh information, produce an external artifact, or act on workspace resources.

Select the best fit for the current request rather than the historical task. Discussion
of an operation is not itself permission to perform it. Distinguish reading existing
results from requesting new work or fresh information. If material ambiguity remains,
select clarification. Do not select execution merely because tools exist or an earlier
goal remains unresolved.

Apply these boundaries before selecting execution:
- Writing, rewriting, translating, summarizing or analyzing text directly in the
  conversation is conversation when no external resource or workflow is requested.
  An imperative such as "write me an email" does not by itself require execution.
  Sending the email or explicitly using a workflow is different.
- A refusal, pause, or request to explain instead replaces the earlier execution
  request. Classify the requested explanation/discussion, without an action quote.
- A contextual confirmation is execution only when its target and scope are clear.
  An unresolved choice between multiple tasks or references such as "that one again"
  without a unique referent is clarification. Do not pick a target or fill in missing
  scope to make the message executable.
- A clear execution request can still lack required parameters. Its intent may be
  execution, but that classification does not supply or authorize guessed inputs.

For execution, actionQuote is an exact, nonempty excerpt from the latest user message
expressing or confirming the requested work. Context can resolve that excerpt's scope,
but cannot replace it with a quote from an earlier turn. For other intents actionQuote
is empty. summary briefly describes the current request in the user's language; it is
public-facing intent, not internal reasoning, an execution claim or a promised outcome.
