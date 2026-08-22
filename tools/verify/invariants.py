"""
Conserved-quantity checks for the main.py -> api/ split.

Every number here was measured against the tree at the moment the OpenAPI gate
last passed byte-identical, so they are known-good. The point is that from here
on nothing may go DOWN: a `Depends(require_role([...]))` lost from the
continuation line of a wrapped decorator, or a `manager.broadcast(...)` lost
from the end of a mutating handler, leaves the route list and (for broadcasts)
the OpenAPI document completely unchanged.
"""

import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Guards and broadcasts must never decrease.
MIN_ROLE_GUARDS = 36
MIN_BROADCASTS = 35   # real `await manager.broadcast(` call sites, excluding
                      # the one mention inside api/realtime.py's docstring


def main():
    os.chdir(ROOT)
    files = ["main.py"] + sorted(glob.glob("api/*.py"))

    guards = broadcasts = 0
    get_db_defs = []
    imports_main = []

    for f in files:
        src = open(f, encoding="utf-8").read()
        guards += len(re.findall(r"Depends\(\s*require_role\(", src))
        if os.path.basename(f) != "realtime.py":
            broadcasts += len(re.findall(r"await manager\.broadcast\(", src))
        if f != "main.py":
            if re.search(r"^def get_db\b", src, re.M):
                get_db_defs.append(f)
            if re.search(r"^\s*(?:from|import)\s+main\b", src, re.M):
                imports_main.append(f)

    fails = []
    print(f"    files                     {len(files)} ({len(files) - 1} in api/)")
    print(f"    Depends(require_role(     {guards:3}   (>= {MIN_ROLE_GUARDS})")
    if guards < MIN_ROLE_GUARDS:
        fails.append(f"role guards dropped to {guards}, was {MIN_ROLE_GUARDS}")

    print(f"    await manager.broadcast(  {broadcasts:3}   (>= {MIN_BROADCASTS})")
    if broadcasts < MIN_BROADCASTS:
        fails.append(f"broadcasts dropped to {broadcasts}, was {MIN_BROADCASTS}")

    print(f"    get_db defs in api/       {len(get_db_defs):3}   (must be 1: {get_db_defs})")
    if len(get_db_defs) != 1:
        fails.append(f"get_db must be defined exactly once in api/, found {get_db_defs}")

    print(f"    api/* importing main      {len(imports_main):3}   (must be 0)")
    if imports_main:
        fails.append(f"package invariant broken — these import main: {imports_main}")

    lines = sum(1 for _ in open("main.py", encoding="utf-8"))
    print(f"    main.py                   {lines} lines")

    if fails:
        print("    INVARIANT FAIL")
        for f in fails:
            print(f"      - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
