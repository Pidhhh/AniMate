"""A minimal OpenAI-compatible endpoint, for exercising the chat chain.

Serves just enough to be useful:

    POST /v1/chat/completions   streaming SSE, a tagged reply
    POST /v1/audio/speech       a short WAV

Deliberately stdlib-only and single-threaded: it exists to be started, hit, and
thrown away. Run it, point AniMate's Base URL at http://127.0.0.1:<port>/v1,
and the whole path — proxy, streaming, parsing, speech — can be exercised
without a real provider or a human at the keyboard.

    python mock-openai.py 8123

It also prints each request it receives, which is how you confirm the proxy
actually forwarded rather than the call failing silently.
"""

import json
import struct
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

# A reply shaped exactly like a real one: machine tag, then the spoken line.
REPLY = "[emotion:happy|attitude:agree] Oh, hello! I was hoping you would come by."


def wav_bytes(seconds: float = 0.4, rate: int = 8000) -> bytes:
    """A quiet sine, so playback has something real to decode."""
    frames = int(seconds * rate)
    samples = bytearray()
    for i in range(frames):
        # 220 Hz, low amplitude — audible but not startling.
        value = int(2000 * __import__("math").sin(2 * 3.14159265 * 220 * i / rate))
        samples += struct.pack("<h", value)

    data_size = len(samples)
    header = b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", data_size)
    return header + bytes(samples)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib signature
        sys.stdout.write(f"[mock] {self.command} {self.path} :: {fmt % args}\n")
        sys.stdout.flush()

    def _read_body(self) -> dict:
        """Read the request body, chunked or not.

        The proxy forwards a streamed body with `Transfer-Encoding: chunked`
        and **no** `Content-Length`. Reading only the length therefore yields
        an empty body — which looks exactly like the proxy dropping it, and
        sends you debugging the wrong side of the wire.

        The symptom is subtle rather than loud: `stream` reads as absent, so
        this mock answers non-streaming, the client quietly falls back to
        parsing one JSON object, and the turn still succeeds. Everything looks
        fine while the SSE path goes completely untested.
        """
        if (self.headers.get("Transfer-Encoding") or "").lower() == "chunked":
            chunks = []
            while True:
                size_line = self.rfile.readline().strip()
                if not size_line:
                    break
                try:
                    size = int(size_line.split(b";")[0], 16)
                except ValueError:
                    break
                if size == 0:
                    self.rfile.readline()  # trailing CRLF
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.readline()  # CRLF after each chunk
            raw = b"".join(chunks)
        else:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"

        try:
            return json.loads(raw or b"{}")
        except Exception:
            return {}

    def do_POST(self):  # noqa: N802 - stdlib signature
        body = self._read_body()
        auth = self.headers.get("Authorization") or "(none)"

        if self.path.endswith("/chat/completions"):
            print(f"[mock] chat: model={body.get('model')} stream={body.get('stream')} auth={auth[:16]}")

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()

            # Stream in small pieces so the client's line buffering is exercised
            # properly — including a token split across two chunks.
            words = REPLY.split(" ")
            for index, word in enumerate(words):
                piece = word + (" " if index < len(words) - 1 else "")
                payload = json.dumps({"choices": [{"delta": {"content": piece}}]})
                self.wfile.write(f"data: {payload}\n\n".encode())
                self.wfile.flush()
                time.sleep(0.03)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        if self.path.endswith("/audio/speech"):
            print(f"[mock] speech: model={body.get('model')} voice={body.get('voice')} auth={auth[:16]}")
            audio = wav_bytes()

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(audio)
            return

        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "27")
        self.end_headers()
        self.wfile.write(b'{"error":{"message":"no"}}')


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"[mock] listening on http://127.0.0.1:{port}/v1")
    sys.stdout.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
