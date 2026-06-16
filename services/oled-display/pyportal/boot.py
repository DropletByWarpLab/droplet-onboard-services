"""
boot.py — runs once at CircuitPython boot, before code.py.

Enables the second USB CDC serial port (`usb_cdc.data`) so host→display
traffic is isolated from the REPL console. That second port appears on the
inference host as /dev/ttyACM1 while the REPL stays on /dev/ttyACM0.

If you need to re-enter the REPL for debugging, console=True keeps
/dev/ttyACM0 available as the interactive Python prompt.
"""

import usb_cdc

usb_cdc.enable(console=True, data=True)
