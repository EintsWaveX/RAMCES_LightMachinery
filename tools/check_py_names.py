"""
Names that main.py and the api/ package read but never bind.

    py -3.10 tools/check_py_names.py

There is no pyflakes or flake8 installed for py -3.10 on this machine and this
project has no test suite, so nothing catches the one failure a large mechanical
move actually causes:

    a function moves to a new module, but a helper it CALLS stays behind.

Python resolves globals at CALL time, not at import. The result imports cleanly,
produces an identical route table, produces a byte-identical openapi.json — and
then raises NameError the first time that single endpoint is requested. This
happened during the main.py → api/ split: `get_public_aset` stayed in main.py
while `_varian_payload` moved to api/master.py, and every static gate passed
until the QR card was actually fetched.

What it does
------------
Parse each file with `ast`, collect every name the file BINDS anywhere — module
imports, defs, classes, assignments, function parameters, for/with/except
targets, comprehension variables, walrus targets, globals — and every name it
LOADS. Report loads that match no binding and are not builtins.

What it deliberately does NOT do
--------------------------------
This is a FLAT analysis, not a scope-aware one: a name bound in any function
counts as bound for the whole file. That makes it blind to "defined in the wrong
function", but it means **zero false positives**, which is what makes it usable
as a gate. The bug class it exists for — a name that exists in no scope at all
because it was left behind in another module — is caught exactly.

It is a name checker, not a type checker. It cannot see a missing attribute, a
wrong argument count, or a helper that moved but happened to keep working.
"""

import ast
import builtins
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
API_DIR = os.path.join(ROOT, "api")

# Names that are legitimately free in any module.
KNOWN_FREE = {"__file__", "__name__", "__doc__", "__package__", "__spec__"}


def _targets(node, out):
    """Every name an assignment / for / with / except target introduces."""
    if isinstance(node, ast.Name):
        out.add(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for e in node.elts:
            _targets(e, out)
    elif isinstance(node, ast.Starred):
        _targets(node.value, out)
    # Attribute and Subscript targets bind nothing new.


def bindings(tree):
    """Every name bound anywhere in the module, at any depth."""
    bound = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names:
                if a.name != "*":
                    bound.add(a.asname or a.name.split(".")[0])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            bound.add(node.name)
            args = node.args
            for a in (
                list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs)
            ):
                bound.add(a.arg)
            if args.vararg:
                bound.add(args.vararg.arg)
            if args.kwarg:
                bound.add(args.kwarg.arg)
        elif isinstance(node, ast.ClassDef):
            bound.add(node.name)
        elif isinstance(node, ast.Lambda):
            args = node.args
            for a in (
                list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs)
            ):
                bound.add(a.arg)
            if args.vararg:
                bound.add(args.vararg.arg)
            if args.kwarg:
                bound.add(args.kwarg.arg)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                _targets(t, bound)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            _targets(node.target, bound)
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            _targets(node.target, bound)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    _targets(item.optional_vars, bound)
        elif isinstance(node, ast.ExceptHandler):
            if node.name:
                bound.add(node.name)
        elif isinstance(node, ast.comprehension):
            _targets(node.target, bound)
        elif isinstance(node, ast.NamedExpr):  # walrus
            _targets(node.target, bound)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            bound.update(node.names)
    return bound


def check(path):
    """Return {name: [linenos]} for names read but never bound, or None to skip."""
    with open(path, encoding="utf-8") as fh:
        tree = ast.parse(fh.read(), filename=path)

    # A star import binds an unknowable set. api/ forbids them, but if one
    # appears, skipping is honest where a wall of false positives is not.
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and any(a.name == "*" for a in node.names):
            return None

    bound = bindings(tree)
    unresolved = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            name = node.id
            if name in bound or name in KNOWN_FREE or hasattr(builtins, name):
                continue
            unresolved.setdefault(name, []).append(node.lineno)
    return unresolved


def targets():
    found = []
    if os.path.isfile(os.path.join(ROOT, "main.py")):
        found.append(os.path.join(ROOT, "main.py"))
    if os.path.isdir(API_DIR):
        for n in sorted(os.listdir(API_DIR)):
            if n.endswith(".py"):
                found.append(os.path.join(API_DIR, n))
    return found


def rel(path):
    return os.path.relpath(path, ROOT).replace("\\", "/")


def main():
    paths = targets()
    if not paths:
        print("no main.py or api/ package found")
        return 1

    print(f"Unresolved global names ({len(paths)} files)")
    failures = []
    for path in paths:
        try:
            result = check(path)
        except SyntaxError as exc:
            print(f"   FATAL {rel(path)}: syntax error line {exc.lineno}: {exc.msg}")
            failures.append(rel(path))
            continue
        if result is None:
            print(f"   skip  {rel(path)} (star import)")
            continue
        for name in sorted(result):
            lines = result[name]
            shown = ", ".join(str(n) for n in lines[:4])
            more = f" (+{len(lines) - 4} more)" if len(lines) > 4 else ""
            print(f"   FAIL  {rel(path)}:{shown}{more}  →  {name}")
            failures.append(f"{rel(path)}: {name}")

    print()
    print("=" * 58)
    if failures:
        print(f"FAILED ({len(failures)})")
        return 1
    print("OK — every name resolves to a binding in its own file")
    return 0


if __name__ == "__main__":
    sys.exit(main())
