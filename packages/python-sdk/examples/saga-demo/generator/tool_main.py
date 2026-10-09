from business import generate
from workrun_sdk import tool


@tool(
    name="generate_demo_document",
    description="Create one demo document for the supplied caseId.",
)
def generate_demo_document(caseId: str):
    return generate(caseId)
