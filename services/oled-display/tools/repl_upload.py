#!/usr/bin/env python3
"""Write files to a CircuitPython board over the USB-serial REPL.

When CircuitPython has flash write access (the board's `code.py` calls
`storage.remount('/', readonly=False)`, or settings.toml grants it), the
host-side USB-MSC view of CIRCUITPY is read-only — so the only way to update
boot.py / code.py / lib from the host is over the raw REPL on /dev/ttyACM0.
That is what `mpremote` does, but mpremote (and pip) aren't installed on the
appliance; this is a minimal, dependency-light stand-in (pyserial only).

Usage:
    sudo python3 repl_upload.py --port /dev/ttyACM0 \
        --push pyportal/code.py:code.py \
        --push pyportal/boot.py:boot.py

Each --push is SRC[:DEST]; DEST defaults to basename(SRC). After all pushes
the board is soft-rebooted so the new code.py runs. Exit code is non-zero if
any write fails its size read-back.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

try:
    import serial  # pyserial
except ImportError:
    sys.exit("pyserial is required: apt-get install python3-serial")


class ReplError(RuntimeError):
    pass


def _read_until(ser, token: bytes, timeout: float = 8.0) -> bytes:
    """Read from the serial port until `token` is seen or timeout elapses."""
    deadline = time.monotonic() + timeout
    buf = bytearray()
    while time.monotonic() < deadline:
        chunk = ser.read(256)
        if chunk:
            buf.extend(chunk)
            if token in buf:
                return bytes(buf)
        else:
            time.sleep(0.01)
    raise ReplError(
        f"timeout waiting for {token!r}; got tail {bytes(buf)[-120:]!r}"
    )


def enter_raw_repl(ser) -> None:
    # Interrupt any running program (code.py), twice for good measure, then
    # request the raw REPL. CircuitPython prints the raw-REPL banner.
    ser.write(b"\r\x03\x03")
    time.sleep(0.1)
    ser.reset_input_buffer()
    ser.write(b"\r\x01")
    _read_until(ser, b"raw REPL; CTRL-B to exit\r\n>")


def exit_raw_repl(ser) -> None:
    ser.write(b"\r\x02")
    time.sleep(0.1)


def exec_raw(ser, command: bytes, timeout: float = 10.0) -> bytes:
    """Run one command in the raw REPL; return its stdout. Raise on board error.

    Raw-REPL response framing: ``OK`` <stdout> \\x04 <stderr> \\x04 ``>``.
    """
    ser.write(command)
    ser.write(b"\x04")  # EOT -> execute
    # Read the WHOLE response frame in one pass — reading to 'OK' and then to
    # '\x04>' separately loses bytes, because a single serial read can return
    # the entire frame at once and the bytes past the first token are dropped.
    frame = _read_until(ser, b"\x04>", timeout=timeout)
    idx = frame.find(b"OK")
    if idx < 0:
        raise ReplError(f"raw REPL did not ack; frame {frame[-120:]!r}")
    inner = frame[idx + 2 : -2]  # strip leading 'OK' and trailing '\x04>'
    out, _, err = inner.partition(b"\x04")
    if err.strip():
        raise ReplError(f"board error: {err.decode('utf-8', 'replace').strip()}")
    return out


def push_file(ser, src: str, dest: str, chunk: int = 256) -> None:
    with open(src, "rb") as fh:
        data = fh.read()
    # Make the filesystem writable from the REPL side. CircuitPython blocks
    # code/REPL writes while the CIRCUITPY drive is mounted by the host
    # (concurrent-write protection), so a plain remount stays read-only here.
    # disable_concurrent_write_protection lifts that guard so the write can go
    # through while USB-MSC is still enumerated — which is ONLY safe because the
    # host is not writing the FAT concurrently. The caller (flash-pyportal.sh)
    # guarantees this by unmounting the host's CIRCUITPY view before invoking
    # this tool; run standalone, ensure CIRCUITPY is NOT mounted read-write on
    # the host first, or you risk FAT corruption.
    exec_raw(
        ser,
        b"import storage\nstorage.remount('/', readonly=False, disable_concurrent_write_protection=True)",
    )
    exec_raw(ser, b"f=open(%r,'wb')" % dest)
    for i in range(0, len(data), chunk):
        exec_raw(ser, b"f.write(%r)" % data[i : i + chunk])
    exec_raw(ser, b"f.close()")
    size = exec_raw(ser, b"import os\nprint(os.stat(%r)[6])" % dest)
    written = int(size.strip() or b"-1")
    if written != len(data):
        raise ReplError(f"{dest}: wrote {written} bytes, expected {len(data)}")
    print(f"  {src} -> :{dest} ({written} bytes) OK")


def main() -> int:
    ap = argparse.ArgumentParser(description="Upload files to a CircuitPython board over the REPL.")
    ap.add_argument("--port", default="/dev/ttyACM0", help="serial REPL port (default /dev/ttyACM0)")
    ap.add_argument("--push", action="append", default=[], metavar="SRC[:DEST]",
                    help="file to upload; repeatable")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--no-reboot", action="store_true", help="do not soft-reboot after upload")
    ap.add_argument("--list", action="store_true", help="list the board's root dir and exit WITHOUT uploading (handshake check)")
    args = ap.parse_args()

    pushes = []
    for spec in args.push:
        src, _, dest = spec.partition(":")
        pushes.append((src, dest or os.path.basename(src)))

    with serial.Serial(args.port, args.baud, timeout=0.2) as ser:
        time.sleep(0.2)
        enter_raw_repl(ser)
        try:
            # Always list first — cheap handshake proof + a record of what was
            # on the board before any write.
            listing = exec_raw(ser, b"import os\nprint(os.listdir('/'))")
            print("board /:", listing.decode("utf-8", "replace").strip())
            if args.list:
                # Read-only handshake check: we've proven the REPL responds and
                # shown the root dir. Stop here WITHOUT writing anything. (We
                # still soft-reboot below so the interrupted code.py resumes —
                # a frozen REPL would leave the screen stuck.)
                pushes = []
            for src, dest in pushes:
                push_file(ser, src, dest)
        finally:
            exit_raw_repl(ser)
        # ALWAYS soft-reboot (unless told not to) so the interrupted code.py
        # resumes — otherwise a read-only --list would leave the screen frozen
        # at the REPL.
        if not args.no_reboot:
            ser.write(b"\x04")  # soft reboot -> (re)run code.py
            print("soft-reboot sent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
