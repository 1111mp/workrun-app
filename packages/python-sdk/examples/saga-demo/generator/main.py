import json
import sys

from business import generate
from workrun_sdk import process

if __name__ == "__main__":
    state = json.load(sys.stdin)
    process.result(generate(state["caseId"]))
