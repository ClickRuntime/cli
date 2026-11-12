"""Parallel token reads refresh once: the credentials lock keeps two refreshes with one refresh
token from reaching the server (which would treat the second as reuse and end the sign-in)."""

import http.server
import json
import os
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


class RefreshLockTest(unittest.TestCase):
    def test_parallel_access_token_refreshes_once(self):
        count = {"n": 0}
        lock = threading.Lock()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                with lock:
                    count["n"] += 1
                    n = count["n"]
                time.sleep(0.05)
                body = json.dumps({"access_token": "at-%d" % n, "refresh_token": "rt-%d" % n, "expires_in": 3600}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        d = tempfile.mkdtemp(prefix="crcli-")
        os.environ["CLICKRUNTIME_CONFIG_DIR"] = d
        os.environ["CLICKRUNTIME_AUTH_URL"] = "http://127.0.0.1:%d" % server.server_address[1]
        os.environ.pop("CLICKRUNTIME_TOKEN", None)
        with open(os.path.join(d, "credentials.json"), "w") as f:
            json.dump({"profiles": {"default": {"access_token": "old", "refresh_token": "rt-0", "expires_at": 1}}}, f)
        try:
            from clickruntime_cli import client

            tokens, errors = [], []

            def worker():
                try:
                    tokens.append(client.access_token("default")[0])
                except Exception as e:  # noqa: BLE001
                    errors.append(e)

            threads = [threading.Thread(target=worker) for _ in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertEqual(errors, [])
            self.assertEqual(count["n"], 1)
            self.assertEqual(set(tokens), {"at-1"})
            self.assertFalse(os.path.exists(os.path.join(d, "credentials.lock")))
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()
