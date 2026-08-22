// ═══════════════════════════════════════════════════════════════════════
// The single matcher used by every search box, filter, sort and card
// label, plus the Map indexes that make it O(1) and the shared
// asset-id / lokasi decoders.
//
// Part of the RAMCES frontend. These files are plain classic scripts
// loaded in a fixed order by index.html - no bundler, no modules. They
// share one global scope, so a top-level `let` or `const` declared twice
// across two files is a fatal SyntaxError; see CLAUDE.md.
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// SEARCH / MATCH HELPERS
//
// Every list in this app filters an in-memory array; nothing is searched
// server-side. Before this block each view rolled its own matcher, and they
// disagreed in two ways that were visible to the user:
//
//   1. The asset cards PRINT the owning DAOP ("DAOP 1 JAKARTA"), but the
//      matchers compared against the resort name the backend sends
//      ("JR 1.1 Gambir"). Typing a string straight off the card matched
//      nothing.
//   2. Everything used unanchored `includes()`, so the naive fix would have
//      made "DAOP 1" also match DAOP 10 and "DIVRE I" match DIVRE II/III/IV.
//
// The fix is one identity per asset (used by cards, search, filters and sort
// alike) and one matcher that understands the three shapes a location term can
// take: a region label, a bare code, or free text.
// ═══════════════════════════════════════════════════════════════════════════

function normalizeSearchText(value) {
  return (value ?? "").toString().toUpperCase().replace(/\s+/g, " ").trim();
}

// ── Lookup indexes ─────────────────────────────────────────────────────────
//
// `assetLokasiIdentity` used to run three Array.find() scans per call —
// _historySummary (one row per asset), uptDatabase (~205 rows) and lokasiData.
// It is called roughly twice per asset per render, and none of the six search
// boxes was debounced, so typing one character into Kelola Data Aset cost
// ~168,000 array comparisons at only 200 assets. That is quadratic in fleet
// size: at 10,000 assets it is hundreds of millions per keystroke.
//
// These Maps make the same lookups O(1). They are rebuilt wherever their source
// array is replaced — never mutated piecemeal — so they cannot drift out of
// sync with it.
let _uptByCode = new Map();
let _lokasiByCode = new Map();
let _summaryById = new Map();

function rebuildLokasiIndexes() {
  _uptByCode = new Map(uptDatabase.map((u) => [u.upt, u]));
  _lokasiByCode = new Map(lokasiData.map((l) => [l.code, l]));
}

function rebuildSummaryIndex() {
  _summaryById = new Map(_historySummary.map((s) => [s.id_aset, s]));
}

/** The summary row for one asset, or undefined. O(1). */
function summaryFor(idAset) {
  return idAset ? _summaryById.get(idAset) : undefined;
}

/**
 * Trailing debounce.
 *
 * Every search box re-filtered, re-sorted and re-rendered its whole list on
 * each `input` event. At a normal typing speed that is ~8 full renders per
 * second, all but the last of them discarded.
 */
function debounce(fn, wait = 200) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

// "DAOP 1", "DIVRE III", "BALAI YASA", "DAERAH OPERASI 5" — a region NAME with
// its ordinal. Matched whole, so the ordinal can be compared as a token rather
// than a substring.
const _RE_REGION_TERM =
  /^(DAOP|DAERAH OPERASI|DIVRE|DIVISI REGIONAL|BALAI ?YASA)(?: ([0-9]+|[IVX]+))?$/;

// A location CODE as it appears in id_lokasi: D1, VIII, BY2, BY1A, JR1.3, JRIII.7.
const _RE_LOKASI_CODE = /^(D\d+|V[IVX]*|BY\d+[A-Z]*|JR[\dIVX]+(?:\.\d+)?)$/;

// Whole-token prefix match: ["DAOP","1"] matches "DAOP 1 JAKARTA" but NOT
// "DAOP 10 SURABAYA", because token "1" !== token "10". This is the single
// line that separates the reported false positive from the false negative.
function _tokenPrefixMatch(name, termTokens) {
  const nameTokens = normalizeSearchText(name).split(" ");
  if (termTokens.length > nameTokens.length) return false;
  return termTokens.every((t, i) => nameTokens[i] === t);
}

// Region label → the set of lokasi codes it covers (the parent plus every
// resort under it). Returns null when the term is not a region label at all.
function resolveRegionTermToCodes(term) {
  const norm = normalizeSearchText(term);
  if (!_RE_REGION_TERM.test(norm)) return null;

  const termTokens = norm.split(" ");
  const parents = lokasiData
    .filter((l) => _tokenPrefixMatch(l.name, termTokens))
    .map((l) => l.code);
  if (!parents.length) return null;

  const covered = new Set(parents);
  uptDatabase.forEach((u) => {
    const parent = getParentLokasiCode(u.upt) || u.lokasi;
    if (covered.has(parent)) covered.add(u.upt);
  });
  return covered;
}

/**
 * The one place an asset's location is decided.
 *
 * `uptCode` is where the asset BELONGS, not where it currently sits: an asset
 * mutated to a Balaiyasa for repair still reports to its home resort, and the
 * cards have always rendered it that way. Search and filters now read the same
 * value, so a card labelled "DAOP 1 JAKARTA / JR 1.1 Gambir" is found by
 * searching either string and kept by a DAOP 1 filter — previously the card
 * said one thing and both the search and the filter tested another.
 */
function assetLokasiIdentity(item) {
  // Three Map lookups where there used to be three full array scans — this is
  // the app's hottest function, called ~2x per asset per render.
  const summary = summaryFor(item?.id_aset);

  // `identitas_lokasi` is the server's own answer, added to /api/aset in
  // rev0.4.5 and computed by identity_lokasi_expr() in api/query.py. Preferring
  // it is not an optimisation: the client no longer holds the whole
  // `_historySummary`, so the `summary.mutasi` fallback is only populated for
  // assets that happen to be on the Pantau Riwayat page. Reading it first also
  // means the label on a card is BY CONSTRUCTION the value the server filtered
  // and sorted on, rather than a second derivation that has to be kept in step.
  const uptCode =
    item?.identitas_lokasi ||
    summary?.mutasi?.original_lokasi_code ||
    item?.id_lokasi_raw ||
    item?.id_lokasi ||
    "";
  const parentCode = getParentLokasiCode(uptCode) || uptCode;

  const uptEntry = _uptByCode.get(uptCode);
  const parentEntry = _lokasiByCode.get(parentCode);

  return {
    uptCode,
    parentCode,
    uptName:
      uptEntry?.nama ||
      item?.identitas_lokasi_name ||
      summary?.mutasi?.original_lokasi_name ||
      item?.lokasi_name ||
      item?.id_lokasi_display ||
      "",
    parentName: parentEntry?.name || parentCode || "",
  };
}

/**
 * Does this asset's location match a free-typed search term?
 *
 * Three term shapes, deliberately handled differently:
 *   region label ("DAOP 1")  → exact code-set membership, so DAOP 10 is out
 *   bare code    ("D1")      → exact code equality, so D10 is out
 *   free text    ("Gambir")  → substring, but over NAMES only; matching codes
 *                              by substring is what would let "D1" hit "D10"
 */
function lokasiMatchesTerm(identity, term) {
  const norm = normalizeSearchText(term);
  if (!norm) return true;

  const regionCodes = resolveRegionTermToCodes(norm);
  if (regionCodes) {
    return regionCodes.has(identity.uptCode) || regionCodes.has(identity.parentCode);
  }

  if (_RE_LOKASI_CODE.test(norm)) {
    return (
      normalizeSearchText(identity.uptCode) === norm ||
      normalizeSearchText(identity.parentCode) === norm
    );
  }

  return (
    normalizeSearchText(identity.uptName).includes(norm) ||
    normalizeSearchText(identity.parentName).includes(norm)
  );
}

/**
 * Region filter (the "Lokasi" dropdown in every sort modal), by CODE.
 * A parent code keeps the parent row itself and every resort beneath it.
 */
function lokasiMatchesCode(identity, wantedCode) {
  if (!wantedCode) return true;
  const wanted = normalizeSearchText(wantedCode);
  return (
    normalizeSearchText(identity.parentCode) === wanted ||
    normalizeSearchText(identity.uptCode) === wanted
  );
}

/**
 * Generic text match across a list of non-location fields.
 *
 * Substring is right here — "GEN" should find "GENSET" — but the caller must
 * NOT pass location fields through it; those go to lokasiMatchesTerm, which
 * knows about token boundaries.
 */
function textMatchesTerm(values, term) {
  const norm = normalizeSearchText(term);
  if (!norm) return true;
  return values.some((v) => normalizeSearchText(v).includes(norm));
}

/**
 * Match an asset-shaped row against a search box.
 *
 * Location is tested by the location-aware matcher; everything else by plain
 * substring. `extra` lets a view add its own searchable fields (the Riwayat
 * view searches technician names and certificate numbers too) without
 * duplicating the location logic.
 */
function assetMatchesSearch(item, term, extra = []) {
  const norm = normalizeSearchText(term);
  if (!norm) return true;

  const identity = assetLokasiIdentity(item);
  if (lokasiMatchesTerm(identity, norm)) return true;

  return textMatchesTerm(
    [
      item.id_aset,
      item.kode_alat,
      item.kode_alat_name,
      item.nama_varian,
      item.nomor_seri,
      item.sumber_pengadaan,
      item.status_terakhir,
      item.peruntukan,
      item.tanggal_pembelian,
      ...extra,
    ],
    norm,
  );
}

// Natural ordering for resort labels: 1.1, 1.2, … 1.10, 1.25 — not
// lexicographic, which puts 1.10 before 1.2. Mirrors upt_sort_key() in main.py.
function uptSortKey(label) {
  const m = normalizeSearchText(label).match(/(\d+)\.(\d+)/);
  if (!m) return [Number.MAX_SAFE_INTEGER, 0, normalizeSearchText(label)];
  return [parseInt(m[1], 10), parseInt(m[2], 10), ""];
}

function compareNaturalLabel(a, b) {
  const ka = uptSortKey(a);
  const kb = uptSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return String(ka[2]).localeCompare(String(kb[2]));
}

// Procurement source has been written several ways over the project's life —
// "DAOP/DIVRE", "DAOP / DIVRE", "DAOP", "DIVRE", and the numeric ID segment
// "1"/"2" that appears inside id_aset. Canonicalising to one of two values and
// comparing EXACTLY beats the previous `includes()`, which matched a stored
// "DAOP/DIVRE" against a wanted "DAOP" but not the reverse, and would happily
// match any label that merely contained the other as a substring.
const _PENGADAAN_PUSAT = "PUSAT";
const _PENGADAAN_DAERAH = "DAOP/DIVRE";

function canonicalPengadaan(value) {
  const norm = (value ?? "").toString().toUpperCase().replace(/\s+/g, "");
  if (!norm) return "";
  if (norm === "1" || norm.includes("PUSAT")) return _PENGADAAN_PUSAT;
  if (norm === "2" || norm.includes("DAOP") || norm.includes("DIVRE"))
    return _PENGADAAN_DAERAH;
  return norm;
}

function _pengadaanMatches(value, wanted) {
  if (!wanted) return true;
  return canonicalPengadaan(value) === canonicalPengadaan(wanted);
}

// ── HISTORY VIEW STATE ─────────────────────────────────────────────────────
let _historyMode = "repair"; // 'repair' | 'kalibrasi' | 'mutasi'
let _historySummary = []; // cached from /api/history/summary

/**
 * ONE page of /api/history/summary, filtered and sorted by the server.
 *
 * This is the heaviest per-asset payload the app produces (~636 B against
 * ~366 B for /api/aset), and until rev0.4.5 the whole of it was downloaded at
 * login — 667 KB and 317 ms at 1,121 assets, on every sign-in and again after
 * every mutation — because the Kelola Data Aset cards needed three badges out
 * of it. Those badges now ride on /api/aset itself, so this is fetched only by
 * the screen that actually displays it, one page at a time.
 *
 * `_historySummary` is therefore the CURRENT PAGE, not the fleet. Anything that
 * used to scan it for a fleet-wide answer must use /ringkasan or ensureFleet().
 */
async function loadHistoryPage(params, { background = true } = {}) {
  const res = await apiFetch(`/history/summary?${params}`, { background });
  if (!res.ok) throw new Error(`Gagal mengambil riwayat (${res.status})`);
  const body = await res.json();
  _historySummary = body.items || [];
  // Keep the id_aset index in step with the array it mirrors. Every read path
  // goes through summaryFor(), so forgetting this would silently return stale
  // identities rather than crash — hence it lives on the same line as the
  // assignment.
  rebuildSummaryIndex();
  if (typeof cacheAset === "function") cacheAset(_historySummary);
  return { items: _historySummary, total: body.total ?? _historySummary.length };
}
window.loadHistoryPage = loadHistoryPage;

// ── Asset ID decoder ───────────────────────────────────────────────────────

const PERUNTUKAN_MAP = {
  A: "JALAN REL",
  B: "JEMBATAN",
  C: "MEKANIK",
  D: "BALAIYASA",
};
// sumber_pengadaan is stored as a string ("PUSAT" / "DAOP/DIVRE"), so the old
// integer keys 1/2 never matched and the map was dead. Keys kept for any legacy
// numeric rows; the string keys are what actually hit.
const PENGADAAN_MAP = {
  1: "PUSAT",
  2: "DAOP / DIVRE",
  PUSAT: "PUSAT",
  "DAOP/DIVRE": "DAOP / DIVRE",
  "DAOP / DIVRE": "DAOP / DIVRE",
};

/**
 * Decode id_aset format: <kode_alat>-<tahun>-<peruntukan>-<id_lokasi>
 * Returns { kodeAlat, tahun, peruntukan, lokasiCode }
 */
function decodeAsetId(id) {
  if (!id) return {};

  // Format baru (menggunakan titik): misal 6.RGM.1.24.A.D1
  if (id.includes(".")) {
    const parts = id.split(".");
    // urutan: nomor(0) . kode(1) . pengadaan(2) . tahun(3) . peruntukan(4) . lokasi(5+)
    if (parts.length >= 6) {
      return {
        kodeAlat: parts[1],
        tahun: parts[3],
        peruntukan: parts[4],
        lokasiCode: parts.slice(5).join("."), // Gabungkan sisa jika lokasi ada titik (misal JR1.1)
      };
    }
  }

  // Format lama (menggunakan strip): misal RGM-24-A-D1
  const parts = id.split("-");
  if (parts.length < 4) return {};
  return {
    kodeAlat: parts[0],
    tahun: parts[1],
    peruntukan: parts[2],
    lokasiCode: parts.slice(3).join("-"),
  };
}

function resolveLokasi(val) {
  if (!val || val === "—") return { parentName: "—", uptName: "—", uptCode: "" };

  // 1. PRIORITY 1: Exact match on UPT code (strictest)
  const uptEntry = uptDatabase.find((u) => u.upt === val);
  if (uptEntry) {
    const parentCode = getParentLokasiCode(uptEntry.upt) || uptEntry.lokasi;
    const parentEntry = lokasiData.find((l) => l.code === parentCode);
    return {
      parentName: parentEntry ? parentEntry.name : parentCode,
      uptName: uptEntry.nama,
      uptCode: uptEntry.upt,
    };
  }

  // 2. PRIORITY 2: Exact match on Parent code
  const parentEntry = lokasiData.find((l) => l.code === val);
  if (parentEntry) {
    return { parentName: parentEntry.name, uptName: "—", uptCode: "" };
  }

  // 3. PRIORITY 3: Fallback to fuzzy/name matches (UPT name, then Parent name)
  const uptByName = uptDatabase.find((u) => u.nama === val);
  if (uptByName) {
    const parentCode = getParentLokasiCode(uptByName.upt) || uptByName.lokasi;
    const parentEntry = lokasiData.find((l) => l.code === parentCode);
    return {
      parentName: parentEntry ? parentEntry.name : parentCode,
      uptName: uptByName.nama,
      uptCode: uptByName.upt,
    };
  }

  const parentByName = lokasiData.find((l) => l.name === val);
  if (parentByName) {
    return { parentName: parentByName.name, uptName: "—", uptCode: "" };
  }

  // 4. Complete fallback
  return { parentName: val, uptName: "—", uptCode: "" };
}
