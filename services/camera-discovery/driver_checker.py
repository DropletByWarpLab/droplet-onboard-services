"""Camera driver detection and health checking.

Checks the host system for required kernel modules, V4L2 devices,
and USB camera hardware. Reports what's present, what's missing,
and can attempt to load missing modules.

Runs inside the camera-discovery container (which has host network mode
and NET_ADMIN capability), but kernel module operations require the
host's /lib/modules to be mounted.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

# Required kernel modules for camera support
REQUIRED_MODULES = [
    ("uvcvideo", "USB Video Class — most USB cameras"),
    ("videodev", "Video4Linux2 core framework"),
    ("videobuf2_v4l2", "V4L2 video buffer integration"),
    ("videobuf2_vmalloc", "V4L2 memory-mapped buffers"),
]

OPTIONAL_MODULES = [
    ("gspca_main", "Generic USB camera driver (older webcams)"),
    ("snd_usb_audio", "USB audio (camera microphones)"),
    ("cdc_ether", "USB ethernet (some IP camera USB links)"),
]

# Common camera USB vendor IDs
CAMERA_VENDOR_IDS = {
    "046d": "Logitech",
    "045e": "Microsoft",
    "0c45": "Sonix Technology",
    "05a3": "ARC International",
    "1871": "Aveo Technology",
    "1b3f": "Generalplus",
    "0ac8": "Z-Star Microelectronics",
    "1415": "Nam Tai (Wyze)",
    "0bda": "Realtek",
    "2b7e": "Reolink",
    "1d6b": "Linux Foundation (virtual)",
}


def _run(cmd: list[str], timeout: float = 5.0) -> tuple[int, str]:
    """Run a command and return (returncode, stdout)."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        return result.returncode, result.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return -1, ""


def _validate_module_name(module: str) -> bool:
    """Validate that a module name contains only safe characters."""
    return bool(re.match(r"^[a-z0-9_]+$", module))


def check_kernel_module(module: str) -> str:
    """Check if a kernel module is loaded, available, or missing."""
    if not _validate_module_name(module):
        logger.warning("Invalid module name rejected: %s", module)
        return "missing"

    # Check if loaded — use re.escape to prevent regex injection
    rc, output = _run(["lsmod"])
    if rc == 0 and re.search(rf"^{re.escape(module)}\s", output, re.MULTILINE):
        return "loaded"

    # Check if available (can be loaded)
    rc, _ = _run(["modinfo", module])
    if rc == 0:
        return "available"

    return "missing"


def check_all_modules() -> list[dict]:
    """Check status of all camera-related kernel modules."""
    results = []

    for module, description in REQUIRED_MODULES:
        status = check_kernel_module(module)
        results.append({
            "module": module,
            "description": description,
            "status": status,
            "required": True,
        })

    for module, description in OPTIONAL_MODULES:
        status = check_kernel_module(module)
        results.append({
            "module": module,
            "description": description,
            "status": status,
            "required": False,
        })

    return results


def detect_video_devices() -> list[dict]:
    """Detect /dev/video* and V4L2 devices."""
    devices = []

    # Check /dev/video* devices
    video_devs = sorted(Path("/dev").glob("video*"))
    for dev in video_devs:
        info: dict = {"device": str(dev), "name": "Unknown"}

        # Read device name from sysfs
        sysfs_name = Path(f"/sys/class/video4linux/{dev.name}/name")
        if sysfs_name.exists():
            info["name"] = sysfs_name.read_text().strip()

        # Get capabilities via v4l2-ctl if available
        rc, output = _run(["v4l2-ctl", "-d", str(dev), "--all"])
        if rc == 0:
            # Extract driver info
            for line in output.splitlines():
                line = line.strip()
                if line.startswith("Driver name"):
                    info["driver"] = line.split(":", 1)[1].strip()
                elif line.startswith("Card type"):
                    info["name"] = line.split(":", 1)[1].strip()
                elif line.startswith("Bus info"):
                    info["bus"] = line.split(":", 1)[1].strip()

        devices.append(info)

    return devices


def detect_usb_cameras() -> list[dict]:
    """Detect USB cameras via lsusb."""
    cameras = []

    rc, output = _run(["lsusb"])
    if rc != 0:
        return cameras

    for line in output.splitlines():
        # Parse: Bus 001 Device 003: ID 046d:0825 Logitech, Inc. Webcam C270
        match = re.match(
            r"Bus (\d+) Device (\d+): ID (\w+):(\w+)\s*(.*)", line
        )
        if not match:
            continue

        bus, device, vendor_id, product_id, description = match.groups()
        vendor_id = vendor_id.lower()

        # Check if this is a known camera vendor
        vendor_name = CAMERA_VENDOR_IDS.get(vendor_id)
        is_camera = vendor_name is not None or any(
            kw in description.lower()
            for kw in ["cam", "video", "webcam", "uvc"]
        )

        if is_camera:
            cameras.append({
                "bus": bus,
                "device": device,
                "vendor_id": vendor_id,
                "product_id": product_id,
                "vendor_name": vendor_name or "Unknown",
                "description": description.strip(),
            })

    return cameras


def check_required_tools() -> list[dict]:
    """Check if required userspace tools are installed."""
    tools = [
        ("v4l2-ctl", "V4L2 camera control utility", True),
        ("ffmpeg", "Media processing (RTSP streams)", True),
        ("lsusb", "USB device listing", True),
        ("ffprobe", "Media stream probing", False),
        ("nmap", "Network scanning (camera discovery)", False),
    ]

    results = []
    for cmd, description, required in tools:
        rc, output = _run(["which", cmd])
        installed = rc == 0

        # Get version if installed
        version = None
        if installed:
            rc, ver_out = _run([cmd, "--version"])
            if rc == 0 and ver_out.strip():
                version = ver_out.strip().splitlines()[0][:60]

        results.append({
            "tool": cmd,
            "description": description,
            "installed": installed,
            "required": required,
            "version": version,
        })

    return results


async def try_load_module(module: str) -> bool:
    """Attempt to load a kernel module via modprobe."""
    if not _validate_module_name(module):
        logger.warning("Refusing to load invalid module name: %s", module)
        return False
    try:
        proc = await asyncio.create_subprocess_exec(
            "modprobe", module,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        rc = await proc.wait()
        if rc == 0:
            logger.info("Loaded kernel module: %s", module)
            return True
        logger.warning("Failed to load module %s (rc=%d)", module, rc)
        return False
    except Exception as e:
        logger.error("modprobe failed for %s: %s", module, e)
        return False


async def auto_fix_drivers() -> dict:
    """Attempt to fix common driver issues.

    Returns a report of what was attempted and what succeeded.
    """
    report: dict = {"actions": [], "success": True}

    # 1. Load missing but available modules
    for module, desc in REQUIRED_MODULES:
        status = check_kernel_module(module)
        if status == "available":
            loaded = await try_load_module(module)
            report["actions"].append({
                "action": f"Load module {module}",
                "result": "success" if loaded else "failed",
            })
            if not loaded:
                report["success"] = False
        elif status == "missing":
            report["actions"].append({
                "action": f"Load module {module}",
                "result": "skipped — module not available on this kernel",
            })

    # 2. Fix video device permissions
    video_devs = list(Path("/dev").glob("video*"))
    for dev in video_devs:
        try:
            os.chmod(str(dev), 0o660)
            report["actions"].append({
                "action": f"Fix permissions on {dev}",
                "result": "success",
            })
        except PermissionError:
            report["actions"].append({
                "action": f"Fix permissions on {dev}",
                "result": "failed — need root privileges",
            })

    return report


def full_driver_report() -> dict:
    """Generate a comprehensive driver status report."""
    modules = check_all_modules()
    video_devices = detect_video_devices()
    usb_cameras = detect_usb_cameras()
    tools = check_required_tools()

    # Summarize health
    required_loaded = sum(
        1 for m in modules if m["required"] and m["status"] == "loaded"
    )
    required_total = sum(1 for m in modules if m["required"])
    tools_installed = sum(1 for t in tools if t["installed"] and t["required"])
    tools_required = sum(1 for t in tools if t["required"])

    health = "healthy"
    if required_loaded < required_total or tools_installed < tools_required:
        health = "degraded"
    if required_loaded == 0 and len(video_devices) == 0:
        health = "no_support"

    return {
        "health": health,
        "summary": {
            "kernel_modules": f"{required_loaded}/{required_total} required modules loaded",
            "video_devices": f"{len(video_devices)} V4L2 device(s)",
            "usb_cameras": f"{len(usb_cameras)} USB camera(s) detected",
            "tools": f"{tools_installed}/{tools_required} required tools installed",
        },
        "kernel_modules": modules,
        "video_devices": video_devices,
        "usb_cameras": usb_cameras,
        "tools": tools,
    }
