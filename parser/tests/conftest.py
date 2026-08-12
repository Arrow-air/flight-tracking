import os
import sys

# Make `arrow_parser` importable regardless of pytest invocation cwd.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
