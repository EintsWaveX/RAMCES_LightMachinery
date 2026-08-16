"""
The server-side twin of `js/search.js` — one matcher, expressed in SQL.

── Why this module exists ──
Every list in this app used to filter an in-memory copy of the whole fleet.
`js/search.js` is the ONE matcher that made that correct: it understands the
three shapes a location term can take, and it decides an asset's location in
exactly one place so a label printed on a card is by construction findable by
searching that string. The cost was that the client had to hold every asset to
search it — 1.06 MB and 460 ms at 1,121 assets, on every login and after every
mutation, growing linearly with the fleet.

Moving the paging to the server means the SERVER now has to answer the same
question, and "close enough" is not an option: a filter that disagrees with the
client's by one row is a fleet member that cannot be found by anyone who reads
the card and types what it says. So this module is a deliberate, line-by-line
port, and `tools/verify/test_paging.py` asserts the two agree on the real fleet
by running BOTH — the client matcher inside Chrome over a full local copy, and
these filters over the database — and comparing the id sets.

── The three rules that are easy to get wrong ──

1. **Location identity is the FIRST MUTATION'S ORIGIN, not the current row.**
   `assetLokasiIdentity()` prefers `summary.mutasi.original_lokasi_code` over
   `id_lokasi`, so an asset that has ever been transferred is searched, filtered
   and labelled under where it started. `identity_lokasi_expr()` is that rule in
   SQL. Note this is NOT `resolve_home_lokasi()`, which only substitutes while
   the asset is sitting at a Balaiyasa — the two answer different questions and
   the difference is visible on any permanently redeployed machine.

2. **A region label is a code SET, never a LIKE.** "DAOP 1" must not match DAOP
   10, and `LIKE 'VI%'` over-matches VI/VII/VIII/VIV. The term is resolved to an
   explicit set of `lokasi` codes in Python — the table is 273 rows and cached —
   and the SQL is an `IN ()`. `region_term_codes()` is the port of
   `resolveRegionTermToCodes()`, token-prefix matched so the ordinal compares as
   a whole token.

3. **Free text is a substring over NAMES ONLY.** Substring over codes is what
   lets "D1" match "D10". A bare code takes the exact-equality path instead.

── Whitespace ──
`normalizeSearchText()` collapses runs of whitespace on BOTH sides of the
comparison. Here the term is collapsed the same way, and the two free-text NAME
columns are collapsed in SQL as well — they are the only ones where a stored
value could contain a run of whitespace, and they live in 104- and 87-row
dimension tables, so the un-indexable `regexp_replace` costs nothing. The code,
enum and date columns are compared with a plain `ilike`.

This module imports from `api.deps` and `models` only. It must never import
`main` (see CLAUDE.md), and `deps.py` must never import it back.
"""

import re
from typing import Optional, Set

from sqlalchemy import Integer, String, case, cast, func, or_, select
from sqlalchemy.orm import aliased

import models
from api.deps import get_parent_lokasi_code, lokasi_rows

# The four `tipe` values `fetchMasterData()` treats as PARENT regions; anything
# else is a UPT. Kept as one tuple because the client splits the master list on
# exactly this test, and the identity names below depend on the same split.
PARENT_TIPE = ("DAOP", "DIVRE", "PUSAT", "BALAIYASA")

# "DAOP 1", "DIVRE III", "BALAI YASA", "DAERAH OPERASI 5" — a region NAME with
# its ordinal, matched whole so the ordinal is a token and not a substring.
_RE_REGION_TERM = re.compile(
    r"^(DAOP|DAERAH OPERASI|DIVRE|DIVISI REGIONAL|BALAI ?YASA)(?: ([0-9]+|[IVX]+))?$"
)

# A location CODE as it appears in id_lokasi: D1, VIII, BY2, BY1A, JR1.3, JRIII.7.
_RE_LOKASI_CODE = re.compile(r"^(D\d+|V[IVX]*|BY\d+[A-Z]*|JR[\dIVX]+(?:\.\d+)?)$")

_WS = re.compile(r"\s+")


def normalize_search_text(value) -> str:
    """`normalizeSearchText()` in js/search.js: upper, collapse runs, trim."""
    if value is None:
        return ""
    return _WS.sub(" ", str(value).upper()).strip()


def _is_parent(row) -> bool:
    return (row.tipe or "").upper() in PARENT_TIPE


def _token_prefix_match(name: str, term_tokens) -> bool:
    """
    `_tokenPrefixMatch()`: ["DAOP","1"] matches "DAOP 1 JAKARTA" but NOT
    "DAOP 10 SURABAYA", because token "1" != token "10". This single comparison
    is what separates the false positive from the false negative.
    """
    name_tokens = normalize_search_text(name).split(" ")
    if len(term_tokens) > len(name_tokens):
        return False
    return all(t == name_tokens[i] for i, t in enumerate(term_tokens))


def region_term_codes(db, term: str) -> Optional[Set[str]]:
    """
    `resolveRegionTermToCodes()`: a region LABEL → every lokasi code it covers
    (the parent plus each resort beneath it). None when the term is not a region
    label at all, or names no region that exists — both cases fall through to the
    bare-code and free-text shapes, exactly as the client does.
    """
    norm = normalize_search_text(term)
    if not _RE_REGION_TERM.match(norm):
        return None

    tokens = norm.split(" ")
    rows = lokasi_rows(db)
    parents = {
        r.id_lokasi
        for r in rows
        if _is_parent(r) and _token_prefix_match(r.nama_lokasi, tokens)
    }
    if not parents:
        return None

    covered = set(parents)
    for r in rows:
        if _is_parent(r):
            continue
        if (get_parent_lokasi_code(r.id_lokasi) or r.id_lokasi) in parents:
            covered.add(r.id_lokasi)
    return covered


def _identity_names(by_code, code: str):
    """
    The (uptName, parentName) `assetLokasiIdentity()` would produce for an asset
    whose identity lokasi is `code`.

    The client reads uptName out of `_uptByCode` (UPT rows only) and falls back
    through the mutation's origin name and the asset's own `lokasi_name` — all
    three of which are the same row's `nama_lokasi`, so one lookup reproduces the
    chain. parentName comes from `_lokasiByCode` (parent rows only), falling back
    to the bare parent CODE when the parent is not a parent row — which is what
    an unparseable code produces.
    """
    entry = by_code.get(code)
    upt_name = entry.nama_lokasi if entry else ""

    parent_code = get_parent_lokasi_code(code) or code
    parent_entry = by_code.get(parent_code)
    parent_name = (
        parent_entry.nama_lokasi
        if parent_entry is not None and _is_parent(parent_entry)
        else parent_code
    )
    return upt_name, parent_name


def lokasi_codes_matching_term(db, term: str) -> Optional[Set[str]]:
    """
    `lokasiMatchesTerm()` inverted: every identity lokasi code a free-typed term
    would match. None means "no term" (matches everything); an empty set means
    "a term that matches no location", which is a real answer and not the same
    thing.

    Inverting it is what keeps the rule in ONE place. The alternative — pushing
    the three term shapes into SQL — needs the roman-numeral parent map in an
    unindexable CASE and would be a second copy of the rule the moment either
    side changed.
    """
    norm = normalize_search_text(term)
    if not norm:
        return None

    rows = lokasi_rows(db)
    by_code = {r.id_lokasi: r for r in rows}
    region = region_term_codes(db, norm)
    is_code = bool(_RE_LOKASI_CODE.match(norm))

    out: Set[str] = set()
    for r in rows:
        code = r.id_lokasi
        parent = get_parent_lokasi_code(code) or code
        if region is not None:
            if code in region or parent in region:
                out.add(code)
        elif is_code:
            if normalize_search_text(code) == norm or normalize_search_text(parent) == norm:
                out.add(code)
        else:
            upt_name, parent_name = _identity_names(by_code, code)
            if norm in normalize_search_text(upt_name) or norm in normalize_search_text(
                parent_name
            ):
                out.add(code)
    return out


def own_region_codes(db, current_user) -> Set[str]:
    """
    The "Aset Saya" narrowing on Kelola Data Aset, as a code set.

    The client reads `id_lokasi` out of the JWT, derives `myRegion` from it, and
    keeps an asset when `identity.parentCode === myRegion || identity.uptCode
    === myLokasiRaw`. A token only ever carries a PARENT code (D1, VIII, BY1),
    so the second half only fires for the rare account pinned to a UPT — but it
    is in the client's condition, so it is in this one.

    An account with no `id_lokasi` gets the empty set, which narrows to nothing.
    The alternative — treating it as "no filter" — would silently show a
    regionless user the whole fleet under a control labelled "Aset Saya".
    """
    mine = (current_user.id_lokasi or "").strip() if current_user is not None else ""
    if not mine:
        return set()
    my_region = get_parent_lokasi_code(mine) or mine
    out = {mine}
    for r in lokasi_rows(db):
        code = r.id_lokasi
        if (get_parent_lokasi_code(code) or code) == my_region:
            out.add(code)
    return out


def lokasi_codes_matching_code(db, wanted: str) -> Optional[Set[str]]:
    """
    `lokasiMatchesCode()` inverted — the "Lokasi" dropdown in every sort modal,
    which is code-valued. A parent code keeps the parent row itself and every
    resort beneath it; a UPT code keeps only that resort.
    """
    if not wanted:
        return None
    norm = normalize_search_text(wanted)
    out: Set[str] = set()
    for r in lokasi_rows(db):
        code = r.id_lokasi
        parent = get_parent_lokasi_code(code) or code
        if normalize_search_text(parent) == norm or normalize_search_text(code) == norm:
            out.add(code)
    return out


# ── Procurement source ─────────────────────────────────────────────────────

_PENGADAAN_PUSAT = "PUSAT"
_PENGADAAN_DAERAH = "DAOP/DIVRE"


def canonical_pengadaan(value) -> str:
    """`canonicalPengadaan()`: collapse every stored spelling onto two values."""
    norm = _WS.sub("", str(value or "").upper())
    if not norm:
        return ""
    if norm == "1" or "PUSAT" in norm:
        return _PENGADAAN_PUSAT
    if norm == "2" or "DAOP" in norm or "DIVRE" in norm:
        return _PENGADAAN_DAERAH
    return norm


def pengadaan_values(db, wanted: str):
    """
    Every `sumber_pengadaan` value stored in `aset` that canonicalises to the
    same thing as `wanted`. A tiny DISTINCT, then an `IN ()` — which beats
    reimplementing the canonicalisation as a SQL CASE and keeps the two spellings
    of the rule from drifting.
    """
    if not wanted:
        return None
    target = canonical_pengadaan(wanted)
    stored = [r[0] for r in db.execute(select(models.Aset.sumber_pengadaan).distinct())]
    return [s for s in stored if canonical_pengadaan(s) == target]


# ── Expressions over `aset` ────────────────────────────────────────────────


def identity_lokasi_expr():
    """
    `assetLokasiIdentity().uptCode` as SQL: the origin of the asset's FIRST
    transfer, or its current `id_lokasi` when it has never moved.

    `nullif(..., '')` because the client chains with `||`, which treats an empty
    string as absent; `coalesce` alone would let a blank origin win.

    Correlated rather than joined so it composes with any query over `aset`.
    `ix_rm_aset_waktu` on (id_aset, waktu_mutasi) is what makes it a per-row
    index lookup instead of a scan.
    """
    RM = models.RiwayatMutasi
    first_origin = (
        select(RM.id_lokasi_asal)
        .where(RM.id_aset == models.Aset.id_aset)
        .order_by(RM.waktu_mutasi.asc())
        .limit(1)
        .correlate(models.Aset)
        .scalar_subquery()
    )
    return func.coalesce(func.nullif(first_origin, ""), models.Aset.id_lokasi)


def peruntukan_letter_expr():
    """
    `decodeAsetId(id).peruntukan` — the LETTER baked into the composite id, not
    the `peruntukan` COLUMN. The two can legitimately disagree (an edit changes
    the column; the id is only minted once), and the KDAK and Kelola Data Aset
    filters have always read the id.

    Dotted form `6.RGM.1.24.A.D1` → segment 5. Legacy dashed form `RGM-24-A-D1`
    → segment 3. The client picks the dotted branch only when there are at least
    six segments, so this does too.
    """
    A = models.Aset.id_aset
    dotted = func.array_length(func.string_to_array(A, "."), 1) >= 6
    return case(
        (dotted, func.split_part(A, ".", 5)),
        else_=func.split_part(A, "-", 3),
    )


def id_urutan_expr():
    """
    `parseInt(id_aset.split(".")[0]) || 0` — the sequence number the "Nomor urut"
    range filter compares against. A legacy dashed id has no leading number, so
    `parseInt` yields NaN and the client coerces it to 0; the CASE does the same
    rather than dropping the row.
    """
    head = func.split_part(models.Aset.id_aset, ".", 1)
    return case((head.op("~")("^[0-9]+$"), cast(head, Integer)), else_=0)


def _text_search_conditions(term: str, KA, AV):
    """
    The non-location half of `assetMatchesSearch()`: plain substring over the
    nine fields the client passes.

    The two NAME columns are whitespace-collapsed in SQL because
    `normalizeSearchText()` collapses both sides; the rest are codes, enum
    strings and dates, which cannot contain a run of whitespace, so they take
    the cheaper `ilike`.

    `KA` / `AV` are ALIASES supplied by the caller, never the mapped classes.
    `/api/aset` eager-loads both relationships with `joinedload`, which builds
    its own anonymous outer joins; referencing the bare class here would add a
    second, unrelated join and quietly produce a cartesian product.
    """
    like = f"%{term}%"

    def collapse(col):
        return func.upper(func.regexp_replace(col, r"\s+", " ", "g"))

    return [
        models.Aset.id_aset.ilike(like),
        models.Aset.kode_alat.ilike(like),
        collapse(KA.nama_alat).like(like),
        collapse(AV.nama_varian).like(like),
        models.Aset.nomor_seri.ilike(like),
        models.Aset.sumber_pengadaan.ilike(like),
        models.Aset.status_terakhir.ilike(like),
        models.Aset.peruntukan.ilike(like),
        cast(models.Aset.tanggal_pembelian, String).ilike(like),
    ]


# ── The Pantau Riwayat search extras ───────────────────────────────────────
#
# `_historySearchMatches()` passes eleven MORE fields to `assetMatchesSearch`
# via its `extra` argument — the technician who filed the last report, the
# certificate number, the reason for the last transfer. Searching a technician's
# name on the screen that displays it has to work, so they are ported too.
#
# Each source row contributes ONE correlated scalar subquery returning its
# searchable fields joined with CHR(1). A separator is needed because a plain
# concatenation lets a term match ACROSS a field boundary — "SO" + "GAMBIR"
# would answer to a search for "O GAM", which the client would not. CHR(1)
# cannot appear in a term typed into an HTML input, so no boundary is spannable.

_SEP = func.chr(1)


def _latest_repair_text():
    RK = models.RiwayatKondisi
    P = aliased(models.Pengguna)
    return (
        select(
            func.concat_ws(
                _SEP,
                RK.kondisi,
                RK.keterangan,
                func.coalesce(P.username, cast(RK.id_pengguna, String)),
            )
        )
        .select_from(RK)
        .outerjoin(P, P.id_pengguna == RK.id_pengguna)
        .where(RK.id_aset == models.Aset.id_aset)
        # `latest_repair` is row_number() over waktu_lapor DESC in
        # /api/history/summary — the same single ordering, no tiebreak.
        .order_by(RK.waktu_lapor.desc())
        .limit(1)
        .correlate(models.Aset)
        .scalar_subquery()
    )


def _latest_kalibrasi_text():
    RKAL = models.RiwayatKalibrasi
    P = aliased(models.Pengguna)
    return (
        select(
            func.concat_ws(
                _SEP,
                RKAL.status,
                RKAL.nomor_sertifikat,
                func.coalesce(RKAL.pelaksana_kalibrasi, P.username),
                RKAL.keterangan,
            )
        )
        .select_from(RKAL)
        .outerjoin(P, P.id_pengguna == RKAL.id_pengguna)
        .where(RKAL.id_aset == models.Aset.id_aset)
        # The endpoint sorts ASC and takes the LAST element; reversing the same
        # two keys and taking the first is the same row, NULL dates included —
        # ASC is NULLS LAST and DESC is NULLS FIRST in PostgreSQL.
        .order_by(RKAL.tanggal_kalibrasi.desc(), RKAL.waktu_input.desc())
        .limit(1)
        .correlate(models.Aset)
        .scalar_subquery()
    )


def _mutasi_text(first: bool):
    """
    The latest transfer's destination/officer/reason, or the FIRST transfer's
    origin NAME — `original_lokasi_name`, which the mutation cards print and the
    search therefore has to see.
    """
    RM = models.RiwayatMutasi
    P = aliased(models.Pengguna)
    L = aliased(models.Lokasi)
    if first:
        cols = func.concat_ws(_SEP, L.nama_lokasi)
        join_on = L.id_lokasi == RM.id_lokasi_asal
        order = RM.waktu_mutasi.asc()
    else:
        cols = func.concat_ws(_SEP, L.nama_lokasi, P.username, RM.alasan_mutasi)
        join_on = L.id_lokasi == RM.id_lokasi_tujuan
        order = RM.waktu_mutasi.desc()
    return (
        select(cols)
        .select_from(RM)
        .outerjoin(L, join_on)
        .outerjoin(P, P.id_pengguna == RM.id_pengguna)
        .where(RM.id_aset == models.Aset.id_aset)
        .order_by(order)
        .limit(1)
        .correlate(models.Aset)
        .scalar_subquery()
    )


def history_extra_conditions(term: str):
    """The eleven Pantau Riwayat fields, as four searchable expressions."""
    like = f"%{term}%"

    def collapse(expr):
        return func.upper(func.regexp_replace(expr, r"\s+", " ", "g"))

    return [
        collapse(_latest_repair_text()).like(like),
        collapse(_latest_kalibrasi_text()).like(like),
        collapse(_mutasi_text(first=False)).like(like),
        collapse(_mutasi_text(first=True)).like(like),
    ]


def apply_aset_filters(query, db, *, q=None, alat=None, pengadaan=None,
                       peruntukan=None, lokasi=None, upt=None, status=None,
                       tahun_from=None, tahun_to=None, id_from=None, id_to=None,
                       scope_codes=None, extra_q=None):
    """
    Every filter Kelola Data Aset and Pantau Riwayat can set, applied to a query
    over `aset`. The caller supplies the query so the same builder serves
    `/api/aset` and `/api/history/summary`.

    `scope_codes` is the "Aset Saya" narrowing — an explicit code set from the
    caller, because it is derived from the CALLER's token, not from a parameter.

    Every argument is optional and an absent one applies no filter, which is what
    lets the client send only the boxes the user actually filled in.
    """
    ident = identity_lokasi_expr()

    if q:
        term = normalize_search_text(q)
        KA = aliased(models.KategoriAlat)
        AV = aliased(models.AlatVarian)
        query = query.outerjoin(
            KA, KA.kode_alat == models.Aset.kode_alat
        ).outerjoin(AV, AV.id_varian == models.Aset.id_varian)
        conds = _text_search_conditions(term, KA, AV)
        codes = lokasi_codes_matching_term(db, term)
        if codes:
            conds.append(ident.in_(list(codes)))
        # Pantau Riwayat adds its own fields to the SAME or_ — they widen the
        # match, so appending them after a filter() had already been applied
        # would narrow it instead.
        if extra_q is not None:
            conds.extend(extra_q(term))
        query = query.filter(or_(*conds))

    if alat:
        query = query.filter(models.Aset.kode_alat == alat)

    if status:
        query = query.filter(models.Aset.status_terakhir == status.upper())

    if pengadaan:
        vals = pengadaan_values(db, pengadaan)
        # An empty list means the term canonicalises to something no row stores.
        # `in_([])` is the correct answer — zero rows — not "no filter".
        query = query.filter(models.Aset.sumber_pengadaan.in_(vals or []))

    if peruntukan:
        query = query.filter(peruntukan_letter_expr() == peruntukan.upper())

    if lokasi:
        codes = lokasi_codes_matching_code(db, lokasi)
        query = query.filter(ident.in_(list(codes or [])))

    if upt:
        query = query.filter(ident == upt)

    if scope_codes is not None:
        query = query.filter(ident.in_(list(scope_codes)))

    if tahun_from:
        query = query.filter(
            func.extract("year", models.Aset.tanggal_pembelian) >= int(tahun_from)
        )
    if tahun_to:
        query = query.filter(
            func.extract("year", models.Aset.tanggal_pembelian) <= int(tahun_to)
        )

    if id_from:
        query = query.filter(id_urutan_expr() >= int(id_from))
    if id_to:
        query = query.filter(id_urutan_expr() <= int(id_to))

    return query


# ── Sorting ────────────────────────────────────────────────────────────────
#
# The sort modal offers six FIELDS and six DIRECTIONS, and the two are not
# orthogonal: "Terbaru/Terlama" always sort by purchase date and
# "Terbanyak/Tersedikit" always sort by recorded activity, whatever field is
# selected. `_historyComparator` / the Kelola Data Aset comparator both read it
# that way, so the direction is checked first here too.

SORT_FIELDS = {
    "id_aset": lambda: models.Aset.id_aset,
    "kode_alat_name": None,  # resolved against the aliased kategori join below
    "sumber_pengadaan": lambda: models.Aset.sumber_pengadaan,
    "tanggal_pembelian": lambda: models.Aset.tanggal_pembelian,
    "peruntukan": lambda: models.Aset.peruntukan,
    "id_lokasi": lambda: models.Aset.id_lokasi,
}

SORT_DIRS = ("date-desc", "date-asc", "count-desc", "count-asc", "asc", "desc")


def event_count_expr():
    """
    `_eventCount()` in SQL: repair events + transfers.

    Repair events are TSO rows only — an SO row is a repair being CLOSED, and
    counting both double-counts every completed job. That is the same rule
    `repair_count_map` in `/api/history/summary` applies, so the number the
    cards print and the number this sorts by cannot disagree.
    """
    RK = models.RiwayatKondisi
    RM = models.RiwayatMutasi
    repairs = (
        select(func.count())
        .select_from(RK)
        .where(RK.id_aset == models.Aset.id_aset, RK.kondisi == "TSO")
        .correlate(models.Aset)
        .scalar_subquery()
    )
    mutasi = (
        select(func.count())
        .select_from(RM)
        .where(RM.id_aset == models.Aset.id_aset)
        .correlate(models.Aset)
        .scalar_subquery()
    )
    return func.coalesce(repairs, 0) + func.coalesce(mutasi, 0)


def apply_aset_sort(query, field: Optional[str], direction: Optional[str]):
    """
    Order a query over `aset` the way the client's comparators did.

    Every branch appends `id_aset` as the final tiebreak. `Array.prototype.sort`
    is stable, so equal rows kept the order they arrived in — which was
    `/api/aset`'s own `ORDER BY id_aset`. Without the tiebreak here, two rows
    with the same purchase date could swap between page 1 and a re-fetch of
    page 1, which is the paging bug that shows a row twice and another never.
    """
    direction = direction if direction in SORT_DIRS else "date-desc"

    if direction in ("date-desc", "date-asc"):
        col = models.Aset.tanggal_pembelian
        # NULLS: `new Date(null)` is the epoch on the client, i.e. the oldest
        # possible value — so a missing date sorts last descending, first
        # ascending. Postgres defaults NULLS LAST on DESC, which agrees.
        order = col.desc() if direction == "date-desc" else col.asc()
        return query.order_by(order, models.Aset.id_aset)

    if direction in ("count-desc", "count-asc"):
        cnt = event_count_expr()
        order = cnt.desc() if direction == "count-desc" else cnt.asc()
        return query.order_by(order, models.Aset.id_aset)

    field = field if field in SORT_FIELDS else "id_aset"
    if field == "kode_alat_name":
        KA = aliased(models.KategoriAlat)
        query = query.outerjoin(KA, KA.kode_alat == models.Aset.kode_alat)
        col = func.upper(func.coalesce(KA.nama_alat, models.Aset.kode_alat))
    else:
        # cast to text first: the client compares `(v || "").toString()`, so
        # tanggal_pembelian sorts as "YYYY-MM-DD" — which happens to agree with
        # date order, but coalescing a DATE with '' is a type error in SQL.
        col = func.upper(func.coalesce(cast(SORT_FIELDS[field](), String), ""))

    order = col.asc() if direction == "asc" else col.desc()
    return query.order_by(order, models.Aset.id_aset)
