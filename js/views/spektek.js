// ═══════════════════════════════════════════════════════════════════════
// Model/Type spec card — ONE renderer, three consumers.
//
// The block that shows a machine's photo, Merk, Model/Type and its five
// specification rows appears in three places: the public QR card
// (landing.html), the Form Pemeliharaan header (view-edit) and the asset
// detail screen. They used to be written separately and drifted; this is the
// single implementation, and landing.html calls into it too.
//
// Shape comes from the client's `Rekap Spek RAMCES.docx`: Merk, Model/Type,
// then five FREE-FORM rows whose labels differ per tool ("Max. Torque" on an
// impact wrench, "Runtime" on a work light). The server has already collapsed
// those five slots into `spec.spesifikasi = [{label, nilai}]` and resolved
// `spec.foto` / `spec.spek` / `spec.manual` to one URL each — see
// `_varian_payload()` in main.py. Do not re-derive any of that here.
//
// Part of the RAMCES frontend: plain classic scripts in a fixed order, one
// shared global scope. A top-level `let`/`const` duplicated across two files
// is a fatal SyntaxError that blanks the whole page, so everything below is a
// function declaration plus explicit `window.*` exports. This file must load
// BEFORE js/views/inventaris.js, which caches DOM nodes at eval time.
// ═══════════════════════════════════════════════════════════════════════

// Escape anything that reaches innerHTML. Spec values are admin-entered free
// text and the photo URL can be an arbitrary external link, so neither is
// trustworthy in an attribute or a text node.
function spekEscape(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

// Only http(s) and same-origin paths. Blocks `javascript:` and `data:` URLs
// from an admin-supplied "paste a link instead" field.
function spekSafeUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  if (/^\//.test(raw)) return raw;
  return /^https?:\/\//i.test(raw) ? raw : "";
}

// ── The photo ────────────────────────────────────────────────────────────
// `object-contain` on a fixed-height band, never `cover`: these are catalogue
// shots of machines on white, and cropping one to fill a box cuts the tool in
// half. A missing photo renders a neutral placeholder of the SAME height so
// the card does not change size when one is added later.
function spekFotoHtml(spec, opts = {}) {
  const height = opts.fotoHeight || "h-44";
  const url = spekSafeUrl(spec && spec.foto);
  if (!url) {
    return `
      <div class="${height} w-full flex flex-col items-center justify-center gap-1.5
                  bg-gray-50 dark:bg-gray-700/30 border-b border-gray-100 dark:border-gray-700
                  text-gray-300 dark:text-gray-600">
        <i class="fas fa-camera text-3xl"></i>
        <span class="text-[10px] font-semibold uppercase tracking-wider">Foto belum tersedia</span>
      </div>`;
  }
  const alt = spekEscape(spec.judul || spec.nama_varian || "Foto alat kerja");
  return `
    <div class="${height} w-full bg-white dark:bg-gray-900/40 border-b border-gray-100 dark:border-gray-700
                flex items-center justify-center overflow-hidden">
      <img src="${spekEscape(url)}" alt="${alt}" loading="lazy" decoding="async"
           class="max-h-full max-w-full object-contain"
           onerror="this.closest('div').innerHTML='&lt;i class=\\'fas fa-image text-3xl text-gray-300 dark:text-gray-600\\'&gt;&lt;/i&gt;'" />
    </div>`;
}

// ── The seven rows ───────────────────────────────────────────────────────
// Merk and Model/Type are rows 1–2 of the template and always render when
// present; rows 3–7 come from `spesifikasi`, already trimmed of empty slots.
function spekRowsHtml(spec) {
  const rows = [];
  if (spec.merk) rows.push(["Merk", spec.merk]);
  if (spec.tipe_model) rows.push(["Model/Type", spec.tipe_model]);
  (spec.spesifikasi || []).forEach((s) => rows.push([s.label, s.nilai]));
  if (spec.keterangan) rows.push(["Keterangan", spec.keterangan]);

  if (!rows.length) {
    return `<p class="col-span-full text-xs text-gray-400 italic">
              Spesifikasi belum dilengkapi untuk Model/Type ini.
            </p>`;
  }

  return rows
    .map(
      ([label, nilai]) => `
      <div>
        <dt class="text-[9px] uppercase font-bold text-gray-400 dark:text-gray-500 tracking-wider mb-0.5">
          ${spekEscape(label)}
        </dt>
        <dd class="font-semibold text-gray-800 dark:text-gray-100 text-sm break-words">
          ${spekEscape(nilai)}
        </dd>
      </div>`,
    )
    .join("");
}

// ── Document links ───────────────────────────────────────────────────────
// An UPLOADED document is Bearer-authenticated, so a plain <a href> would 401
// — those route through `window.bukaDokumenModel`, the same blob-download
// pattern `downloadSertifikat` uses. A pasted external link is just a link.
function spekDocsHtml(spec) {
  const links = [];
  let anyInherited = false;

  const add = (url, isUpload, fromKatalog, icon, label) => {
    const safe = spekSafeUrl(url);
    if (!safe) return;
    // A document inherited from the ALAT KERJA is not this model's own sheet.
    // Saying so matters: the client's PDFs cover a tool type — one file covers
    // four different tools — so presenting one as the spec for the exact
    // machine in front of a technician would be a claim the data cannot make.
    const suffix = fromKatalog
      ? ` <span class="text-[9px] font-normal opacity-70">(umum)</span>`
      : "";
    if (fromKatalog) anyInherited = true;
    links.push(
      isUpload
        ? `<button type="button" onclick="window.bukaDokumenModel('${spekEscape(safe)}','${spekEscape(label)}')"
             class="btn btn-ghost text-xs"><i class="fas ${icon}"></i> ${label}${suffix}</button>`
        : `<a href="${spekEscape(safe)}" target="_blank" rel="noopener noreferrer"
             class="btn btn-ghost text-xs"><i class="fas ${icon}"></i> ${label}${suffix}
             <i class="fas fa-arrow-up-right-from-square text-[9px] opacity-60"></i></a>`,
    );
  };

  add(spec.spek, spec.spek_is_upload, spec.spek_from_katalog,
      "fa-file-lines", "Spek Lengkap");
  add(spec.manual, spec.manual_is_upload, spec.manual_from_katalog,
      "fa-book", "Manual Instruction");

  // ── The documents the two buttons above cannot reach ──
  //
  // `spec.spek` / `spec.manual` resolve to ONE document each, because
  // `kategori_alat` stores one basename per kind. Three tools are covered by
  // two PDFs apiece, so the second was on disk and reachable by nothing until
  // `dokumen_alat` existed. Anything in `spec.dokumen` that is not already the
  // primary link is listed here rather than replacing the buttons — the
  // primary document stays the prominent one, and this is the overflow.
  const extra = (spec.dokumen || []).filter((d) => !d.utama);
  const extraHtml = extra.length
    ? `<div class="w-full flex flex-wrap items-center gap-2 pt-1">
         <span class="text-[10px] uppercase tracking-wide text-gray-400
                      dark:text-gray-500 w-full">Dokumen lain untuk jenis alat ini</span>
         ${extra
           .map(
             (d) => `<button type="button"
               onclick="window.bukaDokumenModel('${spekEscape(spekSafeUrl(d.url) || "")}','${spekEscape(d.judul)}')"
               class="btn btn-ghost text-xs" title="${spekEscape(d.judul)}">
               <i class="fas ${d.jenis === "MANUAL" ? "fa-book" : "fa-file-lines"}"></i>
               ${spekEscape(d.judul.length > 38 ? d.judul.slice(0, 37) + "…" : d.judul)}
               <span class="text-[9px] font-normal opacity-70">(umum)</span>
             </button>`,
           )
           .join("")}
       </div>`
    : "";
  if (extra.length) anyInherited = true;

  if (!links.length && !extra.length) return "";

  const note = anyInherited
    ? `<p class="w-full text-[10px] text-gray-400 dark:text-gray-500 leading-snug">
         <i class="fas fa-circle-info mr-1"></i>Bertanda <b>(umum)</b> berarti dokumen
         berlaku untuk jenis alat kerja ini secara keseluruhan, bukan khusus
         Model/Type yang tercatat pada aset ini.
       </p>`
    : "";

  return `<div class="px-5 py-3 border-t border-gray-100 dark:border-gray-700
                      flex flex-wrap items-center gap-2">${links.join("")}${extraHtml}${note}</div>`;
}

// ── Public entry point ───────────────────────────────────────────────────
/**
 * Render the spec card into `container`.
 *
 * `spec` is a `_varian_payload()` object, or null/undefined when the asset has
 * no Model/Type — in which case the card HIDES rather than rendering a table
 * of em-dashes, which tells the reader less than no table at all.
 *
 * opts.title      heading text (default "Spesifikasi Alat Kerja")
 * opts.fotoHeight Tailwind height class for the photo band
 * opts.compact    drop the photo (used where space is tight)
 * opts.dokumen    tool-type documents to show when `spec` is null — see below
 */
function renderSpekCard(container, spec, opts = {}) {
  const el =
    typeof container === "string" ? document.getElementById(container) : container;
  if (!el) return false;

  // No Model/Type, but the ALAT KERJA still has documents.
  //
  // 49 of the 87 seeded models are bare rows and many assets resolve to no
  // model at all, so this is not an edge case — and those are exactly the
  // machines whose only documentation is the tool-type spektek. Hiding the
  // whole card because the model is missing hid the client's own PDFs from the
  // technicians most likely to need them. The spec TABLE still does not render
  // (a grid of em-dashes says less than no grid), only the documents.
  const orphanDocs = !spec && Array.isArray(opts.dokumen) ? opts.dokumen : [];
  if (!spec && orphanDocs.length) {
    el.innerHTML = `
      <div class="px-5 py-3 bg-blue-50/70 dark:bg-gray-700/40 border-b border-gray-100
                  dark:border-gray-700 flex items-center gap-2 flex-wrap">
        <i class="fas fa-file-lines text-kai-blue dark:text-blue-400 text-sm"></i>
        <h3 class="text-sm font-bold text-kai-blue dark:text-blue-300">Dokumen Alat Kerja</h3>
      </div>
      <p class="px-5 pt-3 text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
        Aset ini belum punya Model/Type, jadi spesifikasinya belum bisa ditampilkan.
        Dokumen berikut berlaku untuk jenis alat kerjanya.
      </p>
      ${spekDocsHtml({ dokumen: orphanDocs.map((d) => ({ ...d, utama: false })) })}`;
    el.classList.remove("hidden");
    return true;
  }

  if (!spec) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return false;
  }

  const title = opts.title || "Spesifikasi Alat Kerja";
  const badge = spec.judul || spec.nama_varian || "";

  el.innerHTML = `
    <div class="px-5 py-3 bg-blue-50/70 dark:bg-gray-700/40 border-b border-gray-100
                dark:border-gray-700 flex items-center gap-2 flex-wrap">
      <i class="fas fa-screwdriver-wrench text-kai-blue dark:text-blue-400 text-sm"></i>
      <h3 class="text-sm font-bold text-kai-blue dark:text-blue-300">${spekEscape(title)}</h3>
      ${badge ? `<span class="badge badge-info ml-auto">${spekEscape(badge)}</span>` : ""}
    </div>
    ${opts.compact ? "" : spekFotoHtml(spec, opts)}
    <dl class="p-5 grid grid-cols-2 sm:grid-cols-3 gap-y-3 gap-x-4 text-xs">
      ${spekRowsHtml(spec)}
    </dl>
    ${spekDocsHtml(spec)}`;

  el.classList.remove("hidden");
  return true;
}

// Uploaded Spek/Manual documents sit behind `get_current_user`, so they are
// fetched with the bearer token and opened from a blob. Mirrors
// `window.downloadSertifikat` in js/views/aset.js.
async function bukaDokumenModel(url, label) {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      showToast(`Gagal membuka ${label}.`, "error");
      return;
    }
    const blobUrl = URL.createObjectURL(await res.blob());
    window.open(blobUrl, "_blank", "noopener");
    // Revoke late: revoking immediately can race the new tab's own fetch.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (e) {
    showToast(`Gagal membuka ${label}.`, "error");
  }
}

window.renderSpekCard = renderSpekCard;
window.bukaDokumenModel = bukaDokumenModel;
window.spekEscape = spekEscape;
window.spekSafeUrl = spekSafeUrl;
