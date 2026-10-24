# Workflow node index

Read only the node skills needed for the current design. Details are packaged with the application; no source checkout is required.

| Type | Purpose | Skill |
| --- | --- | --- |
| start | Enter a workflow and expose run inputs. | [workflow-node-start](nodes/start.md) |
| end | Complete a workflow branch. | [workflow-node-end](nodes/end.md) |
| agent | Use a configured model, tools and personal skills. | [workflow-node-agent](nodes/agent.md) |
| codeact_agent | Compose authorized tools with restricted Python. | [workflow-node-codeact_agent](nodes/codeact_agent.md) |
| process | Execute an installed Workflow-type App. | [workflow-node-process](nodes/process.md) |
| remote_agent | Call a configured remote A2A agent. | [workflow-node-remote_agent](nodes/remote_agent.md) |
| if_else | Route using two ordered, independent conditions. | [workflow-node-if_else](nodes/if_else.md) |
| switch | Route to the first matching case or default. | [workflow-node-switch](nodes/switch.md) |
| human_review | Pause for a real human approval or rejection. | [workflow-node-human_review](nodes/human_review.md) |
| ask_user_question | Pause for the user to select an option. | [workflow-node-ask_user_question](nodes/ask_user_question.md) |
| subworkflow | Reuse a saved workflow in this workspace. | [workflow-node-subworkflow](nodes/subworkflow.md) |
| terminate | Stop the current workflow and its parents. | [workflow-node-terminate](nodes/terminate.md) |
| group | Organize canvas nodes without executing. | [workflow-node-group](nodes/group.md) |
