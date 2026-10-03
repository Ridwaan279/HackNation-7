import os
import sys

# Tests import sidecar modules directly (the sidecar runs as a script, not a package).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
