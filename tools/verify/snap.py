"""
Snapshot the app's route table and OpenAPI document.

    py -3.10 <this> <label>

Writes <outdir>/routes_<label>.json and <outdir>/openapi_<label>.json.

The sorted route list proves the SET of (path, methods) survived a refactor.
`registration_order` proves the ORDER survived, which the sorted list cannot
show and which matters because `GET /{file_path:path}` shadows everything.
openapi.json is the strongest gate: it also carries every query parameter
default, every response_model, and every security dependency — so a dropped
`require_role` guard shows up there and nowhere else.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Snapshots are a before/after artefact of ONE run, not a build output.
# .gitignore excludes this directory; keep them out of the tracked tree.
OUT = os.path.join(HERE, "_snapshots")
os.makedirs(OUT, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

import main  # noqa: E402


def _as_regex(path):
    """Starlette path pattern -> a regex matching the concrete paths it claims."""
    out, i = "", 0
    for m in re.finditer(r"\{([^}]*)\}", path):
        out += re.escape(path[i : m.start()])
        out += ".+" if ":path" in m.group(1) else "[^/]+"
        i = m.end()
    return re.compile("^" + out + re.escape(path[i:]) + "$")


def _concrete(path):
    """A sample concrete URL for a path pattern, for testing against another."""
    return re.sub(r"\{[^}]*:path\}", "a/b", re.sub(r"\{[^}]*\}", "sample", path))


def _shadow_pairs(rows):
    """
    Every (earlier, later) pair where the EARLIER route would swallow a request
    meant for the later one.

    This is the invariant that registration order actually protects, and it is
    what a `sorted()` diff cannot see. Grouping routes into routers necessarily
    reorders them; what must not change is which routes are unreachable behind
    which others.
    """
    pairs = []
    for i, (p_i, m_i) in enumerate(rows):
        rx = _as_regex(p_i)
        for p_j, m_j in rows[i + 1 :]:
            if p_i == p_j:
                continue
            if not (set(m_i) & set(m_j)) and (m_i and m_j):
                continue
            if rx.match(_concrete(p_j)):
                pairs.append([p_i, p_j])
    return pairs


def _flatten(routes):
    """
    app.routes, with included routers expanded IN PLACE.

    FastAPI 0.139's include_router() does not splice a router's routes into
    app.routes — it inserts one `_IncludedRouter` proxy holding the original.
    Expanding it at the position it occupies is the faithful model: that is
    where its routes sit in the matching order.
    """
    out = []
    for r in routes:
        inner = getattr(r, "original_router", None)
        if inner is not None and hasattr(inner, "routes"):
            out.extend(_flatten(inner.routes))
        else:
            out.append(r)
    return out


def main_():
    label = sys.argv[1] if len(sys.argv) > 1 else "now"

    rows = [
        [r.path, sorted(getattr(r, "methods", None) or [])]
        for r in _flatten(main.app.routes)
    ]
    routes = {
        "sorted": sorted(rows),
        "shadow_pairs": sorted(_shadow_pairs(rows)),
        "registration_order": rows,
    }

    with open(os.path.join(OUT, f"routes_{label}.json"), "w", encoding="utf-8") as f:
        json.dump(routes, f, indent=1, ensure_ascii=False)
        f.write("\n")

    with open(os.path.join(OUT, f"openapi_{label}.json"), "w", encoding="utf-8") as f:
        json.dump(main.app.openapi(), f, indent=1, sort_keys=True, ensure_ascii=False)
        f.write("\n")

    print(f"{label}: {len(rows)} routes, {len(main.app.openapi().get('paths', {}))} openapi paths")
    return 0


if __name__ == "__main__":
    sys.exit(main_())
