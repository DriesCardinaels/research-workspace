"""Installation resource discovery independent of the process working directory."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC_ROOT = ROOT / 'static'
