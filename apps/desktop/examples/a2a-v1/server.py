"""Local A2A v1.0.1 fixture: receive and return inline resources, without an LLM.

Run: python3 apps/desktop/examples/a2a-v1/server.py --port 8088
"""

import argparse
import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import cast

MAX_BYTES = 20 * 1024 * 1024


class FixtureHTTPServer(ThreadingHTTPServer):
    auth_kind: str = "none"
    secret: str = ""
    key_header: str = "X-API-Key"


class Handler(BaseHTTPRequestHandler):
    def authenticated(self):
        # This handler is registered with FixtureHTTPServer below.
        server = cast(FixtureHTTPServer, self.server)
        kind = server.auth_kind
        if kind == "none":
            return True
        expected = f"Bearer {server.secret}" if kind == "bearer" else server.secret
        header = "Authorization" if kind == "bearer" else server.key_header
        if self.headers.get(header) == expected:
            return True
        self.send_response(401)
        self.send_header("Content-Length", "0")
        if kind == "bearer":
            self.send_header("WWW-Authenticate", 'Bearer realm="workrun-fixture"')
        self.end_headers()
        return False

    def do_GET(self):
        if not self.authenticated():
            return
        if self.path != "/.well-known/agent-card.json":
            self.send_error(404)
            return
        port = cast(FixtureHTTPServer, self.server).server_port
        self.reply(
            {
                "name": "Workrun resource fixture",
                "description": "Returns immutable copies of received files and a receipt",
                "version": "1.0.0",
                "supportedInterfaces": [
                    {
                        "url": f"http://127.0.0.1:{port}/a2a",
                        "protocolBinding": "JSONRPC",
                        "protocolVersion": "1.0",
                    }
                ],
                "capabilities": {"streaming": True},
                "defaultInputModes": [
                    "text/plain",
                    "image/*",
                    "video/*",
                    "application/pdf",
                    "application/octet-stream",
                ],
                "defaultOutputModes": [
                    "text/plain",
                    "image/*",
                    "video/*",
                    "application/pdf",
                    "application/octet-stream",
                ],
                "skills": [
                    {
                        "id": "copy-files",
                        "name": "Copy files",
                        "description": "Verify file transport",
                        "tags": ["files", "test"],
                    }
                ],
            }
        )

    def reply(self, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self.authenticated():
            return
        if self.path != "/a2a":
            self.send_error(404)
            return
        if self.headers.get("A2A-Version") != "1.0":
            self.send_error(400, "Expected A2A-Version: 1.0")
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 32 * 1024 * 1024:
            self.send_error(413)
            return
        request = json.loads(self.rfile.read(length))
        request_id = request.get("id")

        def envelope(result):
            return {"jsonrpc": "2.0", "id": request_id, "result": result}

        method = request.get("method")
        if method not in ("SendMessage", "SendStreamingMessage"):
            self.reply(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": "Fixture supports send operations only",
                    },
                }
            )
            return
        try:
            message = request["params"]["message"]
            assert message["role"] == "ROLE_USER"
            parts = message["parts"]
            files = [p for p in parts if "raw" in p]
            assert len(files) <= 10
            decoded = [base64.b64decode(p["raw"], validate=True) for p in files]
            assert sum(map(len, decoded)) <= MAX_BYTES
        except (KeyError, AssertionError, ValueError):
            self.reply(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32602, "message": "Invalid input"},
                }
            )
            return
        artifacts = [
            {
                "artifactId": f"copy-{index}",
                "name": f"copy-{part.get('filename', 'resource.bin')}",
                "parts": [
                    {
                        "raw": part["raw"],
                        "filename": f"copy-{part.get('filename', 'resource.bin')}",
                        "mediaType": part.get("mediaType", "application/octet-stream"),
                    }
                ],
            }
            for index, part in enumerate(files)
        ]
        summary = json.dumps(
            {
                "receivedFiles": len(files),
                "totalBytes": sum(map(len, decoded)),
                "files": [
                    {
                        "name": p.get("filename"),
                        "mediaType": p.get("mediaType"),
                        "size": len(data),
                    }
                    for p, data in zip(files, decoded)
                ],
            },
            ensure_ascii=False,
        )
        status = {
            "state": "TASK_STATE_COMPLETED",
            "message": {
                "messageId": f"reply-{request_id}",
                "role": "ROLE_AGENT",
                "contextId": "fixture-context",
                "taskId": f"task-{request_id}",
                "parts": [{"text": summary}],
            },
        }
        task = {
            "id": f"task-{request_id}",
            "contextId": "fixture-context",
            "status": status,
            "artifacts": artifacts,
        }
        if method == "SendMessage":
            self.reply(envelope({"task": task}))
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        events = [
            {
                "task": {
                    "id": task["id"],
                    "contextId": task["contextId"],
                    "status": {"state": "TASK_STATE_WORKING"},
                }
            }
        ]
        events.extend(
            {
                "artifactUpdate": {
                    "taskId": task["id"],
                    "contextId": task["contextId"],
                    "artifact": artifact,
                    "append": False,
                    "lastChunk": True,
                }
            }
            for artifact in artifacts
        )
        events.append(
            {
                "statusUpdate": {
                    "taskId": task["id"],
                    "contextId": task["contextId"],
                    "status": status,
                }
            }
        )
        for event in events:
            self.wfile.write(
                (
                    "data: " + json.dumps(envelope(event), ensure_ascii=False) + "\n\n"
                ).encode()
            )
            self.wfile.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8088)
    parser.add_argument("--auth", choices=["none", "bearer", "apiKey"], default="none")
    parser.add_argument("--header", default="X-API-Key")
    args = parser.parse_args()
    secret = os.environ.get("WORKRUN_A2A_TEST_SECRET", "")
    if args.auth != "none" and not secret:
        parser.error("Set WORKRUN_A2A_TEST_SECRET for authenticated fixtures")
    server = FixtureHTTPServer(("127.0.0.1", args.port), Handler)
    server.auth_kind = args.auth
    server.key_header = args.header
    server.secret = secret
    print(f"A2A fixture: http://127.0.0.1:{server.server_port}", flush=True)
    server.serve_forever()
