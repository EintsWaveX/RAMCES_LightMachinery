"""
A real JavaScript syntax check for js/ — the thing `node --check` would do.

`tools/check_js.py` is deliberately Node-free and instant, and it catches the
two failures that produce no other signal (a duplicate top-level declaration, an
eval-time call into a later file). What it cannot do is PARSE, because it has no
JavaScript engine — it counts brackets and tokenises.

That gap has a cost, and rev0.4.5 paid it: an `await` added inside a listener
that was not `async` is a SyntaxError, the whole file fails to load, every
function it declares is undefined, and the page blanks. Brackets balanced,
declarations unique, load order fine — every existing check passed.

There is no Node on this machine, but there IS a JavaScript engine: the same
headless Chrome the rest of this harness drives. Each file is compiled with
`new Function(source)`, which parses without executing, so a file with a syntax
error is reported by name and line and nothing runs.

    py -3.10 tools/verify/syntax.py

Needs Chrome. Needs nothing else — no server, no database.
"""

import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(HERE))

sys.path.insert(0, os.path.join(ROOT, "tools"))

from cdp import Chrome  # noqa: E402
from check_js import LOAD_ORDER  # noqa: E402


async def main():
    files = [
        os.path.join(ROOT, "js", rel.replace("/", os.sep)) for rel in LOAD_ORDER
    ]
    missing = [f for f in files if not os.path.exists(f)]
    if missing:
        print("missing from LOAD_ORDER:", missing)
        return 2

    fails = []
    c = Chrome(port=9337)
    await c.start()
    try:
        await c.goto("about:blank", wait=0.5)
        for path in files:
            rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
            src = open(path, encoding="utf-8").read()
            # new Function() parses the body without running it, so a file with
            # top-level side effects (every view file wires listeners) is safe
            # to check. Its own scope is not the page's, which is exactly right:
            # we are asking "does this parse", not "does this run here".
            res = await c.js(
                "try { new Function(%s); return 'ok'; }"
                " catch (e) { return e.constructor.name + ': ' + e.message; }"
                % json.dumps(src)
            )
            if res == "ok":
                print(f"  ok   {rel}")
            else:
                print(f"  FAIL {rel}\n         {res}")
                fails.append(rel)
    finally:
        await c.close()

    print()
    if fails:
        print(f"FAILED - {len(fails)} file(s) do not parse: {', '.join(fails)}")
        return 1
    print(f"OK - all {len(files)} files parse")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
