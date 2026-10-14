import json
import sys

from workrun_sdk import process

state = json.load(sys.stdin)
process.result({"message": f"E2E result: {state['message']}"})
