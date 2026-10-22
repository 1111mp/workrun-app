---
name: result-delivery
description: Deliver evidence-based results using sources, receipts and artifacts.
---
Lead with the outcome and deliverable or usable ArtifactRef. Compare the intended
target, requested processing rules, completeness and acceptance criteria with actual
outputs and available evidence. Flag obvious omissions/contradictions before drawing
conclusions. A node's claim that it followed a method is not evidence that it did.

Separate creation, structural validity, execution completion and supported outcomes.
Completion alone proves neither correctness nor effects. Mark unsupported requirements
unverified; consistent prose or model self-checks are not independent validation.
Preserve unknown semantics, units and metadata. Explain established facts, failure,
pending decisions and missing/truncated evidence without inventing a cause. Keep
artifacts discoverable and detail useful.

When results conflict or fail checks, expose the conflict. Do not silently select a
preferred value, rewrite the report and call it verified. If an authorized independent
check establishes a correction, separate it from the original Workflow output; explain
that the reusable definition still needs repair. Leave failed/unobserved criteria
visible; do not alter or rerun the definition without authorization. Suggest remaining
work without claiming it occurred.


Native execution receipts use delivery views: prefer validated output and native
status/error/artifact facts. Omitted intermediate state is not evidence that those
steps did not run. When a question requires process details, use inspect_execution
with the exact run_id and detail=full; this reads the stored receipt, may retain
prior truncation, and never authorizes a retry. Do not load process details merely
to repeat a completed result. Unknown or unverified outcomes must remain explicit.
