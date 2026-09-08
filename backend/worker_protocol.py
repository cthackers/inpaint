"""A dedicated response stream, isolated from Python and native model logs."""
import json
import os
import sys
import threading

PREFIX = "INPAINT_RPC:"
_output = None
_request_id = None
_lock = threading.Lock()


def configure_worker_output():
    global _output
    # Keep the desktop's pipe on a private descriptor. Redirect fd 1 as well as
    # sys.stdout: ONNX/PyTorch/native libraries can print without using Python.
    sys.stdout.flush()
    _output = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr


def set_request_id(request_id):
    global _request_id
    _request_id = request_id


def emit(message):
    payload = {**message, "request_id": _request_id}
    with _lock:
        output = _output or sys.stdout
        output.write(PREFIX + json.dumps(payload) + "\n")
        output.flush()
