#!/usr/bin/env python3
"""
Cortex1 Thunderbird Sync - Native Messaging Host

This script acts as a bridge between external applications and the
Thunderbird extension. It listens on a TCP port for commands and
relays them to the extension via native messaging.

Usage:
    1. Run this script (it's started by Thunderbird automatically via native messaging)
    2. External apps send JSON commands to port 5002
    3. Commands are relayed to the extension
    4. Results are returned to the caller

Protocol:
    HTTP POST to http://localhost:5002/
    Content-Type: application/json

    Request body:
    {
        "action": "mark_read",
        "messageId": "message-id@example.com"
    }

    Response:
    {
        "success": true,
        "messageId": "message-id@example.com",
        "action": "mark_read"
    }
"""

import json
import struct
import sys
import threading
import socket
from http.server import HTTPServer, BaseHTTPRequestHandler
from queue import Queue, Empty

# Configuration
HTTP_PORT = 5002
HTTP_HOST = "127.0.0.1"

# Queues for communication between HTTP server and native messaging
command_queue = Queue()
response_queues = {}
response_id = 0
response_lock = threading.Lock()


def read_native_message():
    """Read a message from stdin (native messaging protocol)."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack("=I", raw_length)[0]
    message = sys.stdin.buffer.read(length).decode("utf-8")
    return json.loads(message)


def send_native_message(message):
    """Send a message to stdout (native messaging protocol)."""
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


class CommandHandler(BaseHTTPRequestHandler):
    """HTTP request handler for external commands."""

    def log_message(self, format, *args):
        """Suppress default logging."""
        pass

    def do_POST(self):
        """Handle POST requests with commands."""
        global response_id

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")

        try:
            command = json.loads(body)
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        # Create a response queue for this request
        with response_lock:
            response_id += 1
            req_id = response_id
            command["_req_id"] = req_id
            response_queues[req_id] = Queue()

        # Send command to extension
        send_native_message(command)

        # Wait for response (timeout 10 seconds)
        try:
            result = response_queues[req_id].get(timeout=10)
            del result["_req_id"]  # Remove internal ID
        except Empty:
            result = {"success": False, "error": "Timeout waiting for response"}
        finally:
            with response_lock:
                if req_id in response_queues:
                    del response_queues[req_id]

        # Send HTTP response
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode("utf-8"))

    def do_GET(self):
        """Handle GET requests for health check."""
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "port": HTTP_PORT}).encode())
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        """Handle CORS preflight requests."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def http_server_thread():
    """Run the HTTP server in a separate thread."""
    server = HTTPServer((HTTP_HOST, HTTP_PORT), CommandHandler)
    server.serve_forever()


def native_message_loop():
    """Main loop for reading native messages from extension."""
    while True:
        message = read_native_message()
        if message is None:
            break

        # Route response to waiting HTTP request
        req_id = message.get("_req_id")
        if req_id and req_id in response_queues:
            response_queues[req_id].put(message)


def main():
    """Main entry point."""
    # Start HTTP server in background thread
    http_thread = threading.Thread(target=http_server_thread, daemon=True)
    http_thread.start()

    # Run native message loop in main thread
    native_message_loop()


if __name__ == "__main__":
    main()
