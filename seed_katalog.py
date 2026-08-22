"""
Master reference data for RAMCES.

Since rev0.5.2 the two big tables here are READ FROM THE WORKBOOK rather than
transcribed. `seed_katalog_sfm.py` opens `modules/KATALOG SFM.xlsx` and this
module reshapes what it returns:

  KATALOG_ALAT     — the 103 ALAT KERJA (tool types) from
                     `KATALOG SFM.xlsx ▸ KATALOG ALAT KERJA`. The authoritative
                     master for `kategori_alat`.
  KATALOG_UPT      — the 254 resorts from `▸ KATALOG UPT`.

What remains hand-kept is only what is genuinely NOT in the workbook:

  KODE_TANPA_KODE  — codes minted for the three rows the client left blank.
  KATALOG_TAMBAHAN — `BKC`, which the katalog itself marks "Tidak Ditemukan".
  MODEL_DATA       — MODEL/TYPE rows (`alat_varian`) with the seven-row spec
                     block from `Spesifikasi Lengkap Alat Kerja/Rekap Spek
                     RAMCES.docx`, which is a .docx and not machine-read.
  EXTRA_ALAT_REMAP — the repair of a modelling error. `seed.py` used to carry an
                     `EXTRA_ALAT_DATA` list of 26 codes invented to hang the
                     sparepart catalogue off; most of them are MODELS, not alat
                     kerja. `HTT 220 V`, `HTT 3 PHASE`, `GEISMAR HTT` and
                     `HTT PORTABLE` are four models of the one katalog entry
                     `HTT HAND TIE TAMPER`, and they were sitting in
                     `kategori_alat` as if they were peers of it.

IMPORTING THIS MODULE REQUIRES `modules/`. That is deliberate. The previous
version imported cleanly without it, so a checkout missing the drop produced an
empty catalogue, `read_rows()` skipped all 1,121 assets as "kode tidak dikenal",
and the seed printed `0 baru, 0 sudah ada` with nothing raising. Failing at
import is the only honest behaviour.

`seed.py` imports all of it. It is gitignored alongside seed.py/reset.py.
"""

from seed_katalog_sfm import read_katalog as _read_katalog


def _sfm():
    """The parsed workbook. Raises with a usable message if `modules/` is absent.

    `KODE_TANPA_KODE` is passed EXPLICITLY rather than letting the reader import
    it back: this module is still mid-import when the first call happens, and
    relying on a partially-initialised module resolving a name is the kind of
    thing that works until someone reorders two blocks.
    """
    return _read_katalog(kode_tanpa_kode=KODE_TANPA_KODE)


# ══════════════════════════════════════════════════════════════════════
# 1. ALAT KERJA — read straight from KATALOG SFM.xlsx
# ══════════════════════════════════════════════════════════════════════
#
# Columns: (kode, nama, alat_ukur, perlu_kalibrasi, kelompok)
#
# Until rev0.5.2 these 103 rows were TRANSCRIBED here by hand, and the
# transcription had drifted from the sheet it claimed to mirror: DHL and DHS
# carry `Alat Ukur = TRUE` in the workbook and arrived here as False. Nothing
# compared the two, so nobody noticed for a release. The list is gone; the
# workbook is the only path in.
#
# `perlu_kalibrasi` is what gates the Kalibrasi form — a wrong flag is a form
# that silently never appears — which is why seeds/verify.py now compares both
# booleans row by row against the sheet.
#
# `kelompok` comes from the sheet's hidden H/I side table, which enumerates the
# tools that have a spektek document; the two blocks correspond to the two
# `Spesifikasi Lengkap Alat Kerja/` subfolders. IMP and LMP appear in both, so
# the value is a comma-joined set.

# The three rows the client left without a code. Minted here so they can carry
# assets at all; replace them if real codes are ever supplied. read_alat()
# RAISES on a name that is not in this table rather than inventing one.
KODE_TANPA_KODE = {
    "GAUGE CALIBRATOR": "GCL",
    "TRACKER": "TRK",
    "WATER STEAM": "WST",
}

KATALOG_ALAT = [
    (kode, nama, alat_ukur, perlu_kalibrasi, kelompok)
    for kode, nama, alat_ukur, perlu_kalibrasi, kelompok in _sfm().alat
]

# KATALOG_KODE / KATALOG_NAMA lived here and were referenced nowhere. The name
# every caller actually imports is ALL_KODE, further down.


# ══════════════════════════════════════════════════════════════════════
# 2. MODEL/TYPE — the seven-row spec block from Rekap Spek RAMCES.docx
# ══════════════════════════════════════════════════════════════════════
#
# The Rekap fixes the template at seven rows: Merk, Model/Type, then five
# FREE-FORM "Spesifikasi Utama" rows. The labels genuinely differ per tool —
# "Max. Torque" on an impact wrench, "Runtime" on a work light, "Protection
# Class" on both, "Cutting Wheel" on a rail saw — which is why `alat_varian`
# stores label/value pairs and not a fixed quartet of named columns.
#
# Each entry: {kode_alat, merk, tipe_model, spek: [(label, nilai) x <=5],
#              foto_url?, url_spek?}
# `nama_varian` is derived by MODEL_TITLE() below, per the Rekap's own rule.
MODEL_DATA = [
    # ── IMPACT WRENCH ──
    {
        "kode_alat": "IMP",
        "merk": "MILWAUKEE",
        "tipe_model": "M18 ONEFHIWF34 High Torque Impact Wrench",
        "spek": [
            ("Power", "18 V M18 Battery"),
            ("Max. Torque", "1.627 Nm"),
            ("Nut-Busting Torque", "2.034 Nm"),
            ("Max. Bolt Diameter", "M33"),
            ("Tool Reception", '3/4" Square'),
        ],
        "foto_url": "https://www.milwaukeetool.id/media/catalog/product/cache/e399203ecf39df49f17fc7d52d521fa2/m/1/m18onefhiwf34-502x-hero02.png",
        "url_spek": "https://drive.google.com/file/d/1UyoAhie70Dc7LoeublNQ0Z3OIAmtRpWn/view?usp=sharing",
    },
    # ── LAMPU PENERANGAN ──
    {
        "kode_alat": "LMP",
        "merk": "MILWAUKEE",
        "tipe_model": "M18 HOSALC High Output Stand Area Light Charger",
        "spek": [
            ("Power", "M18 Battery"),
            ("Max. Light Output", "6.000 lm"),
            ("Runtime", "2,5 / 3,5 / 7,5 jam"),
            ("Max. Height", "2,2 m"),
            ("Protection Class", "IP34"),
        ],
        "foto_url": "https://www.milwaukeetool.id/media/catalog/product/cache/e399203ecf39df49f17fc7d52d521fa2/m/1/m18_hosalc--hero02.png",
        "url_spek": "https://drive.google.com/file/d/1PRyJ6Vhh7j3UcADRtUz-J8YOozBgMOIw/view?usp=sharing",
    },
    {
        "kode_alat": "LMP",
        "merk": "KERTZ",
        "tipe_model": "DWL-104 Cordless Tripod Light",
        "spek": [
            ("Power Supply", "21 V / 2,2 A"),
            ("Max. Light Output", "6.000 lumens"),
            ("Runtime", "2,5–8,5 jam"),
            ("Max. Height", "2.300 mm"),
            ("Protection Class", "IP65"),
        ],
        "foto_url": "https://cdn.myshoptet.com/usr/www.mighty-seven.cz/user/shop/big/4121_dwl-104-gpt2.png?ff=1&x=1024&y=768&q=85&ts=6a3e6ad3&sg=161563f2",
        "url_spek": "https://drive.google.com/drive/folders/1-WMUxUTHc288toxBELc88_81FGios0F-",
    },
    # ── HAND STAMPER ──
    {
        "kode_alat": "HNS",
        "merk": "KERTZ",
        "tipe_model": "KGC-GX160 Petrol Gasoline Compactor",
        "spek": [
            ("Power", "Honda GX160, 5.5 HP"),
            ("Ram Plate Size", "300 × 800 mm"),
            ("Impact", "60 Nm"),
            ("Impact Rate", "450–700 times/min"),
            ("Machine Weight", "82 kg"),
        ],
        "foto_url": "https://kertz-machine.com/wp-content/uploads/2025/02/petrol-compactor-gasoline-kertz.png",
        "url_spek": "https://drive.google.com/file/d/1c-QXIYWS4vlZfn2J4t5zV1eAr2J6AjAA/view?usp=sharing",
    },
    # ── JACK HAMMER ──
    {
        "kode_alat": "JCK",
        "merk": "KERTZ",
        "tipe_model": "KJGH-49 Petrol Jack Hammer",
        "spek": [
            ("Power", "2.200 W"),
            ("Impact Force", "20–55 J"),
            ("Impact Frequency", "770–1.500 BPM"),
            ("No Load Speed", "6.500 rpm"),
            ("Berat", "18 kg"),
        ],
        "foto_url": "https://sc04.alicdn.com/kf/Hb7269ff75048461daf3718f360e07adfp.jpg",
        "url_spek": "https://drive.google.com/file/d/1Le-9cXUrCIvoacQum3jlAUhcSO6KEN-l/view?usp=sharing",
    },
    # ── MESIN POTONG REL ──
    {
        "kode_alat": "MPR",
        "merk": "KERTZ",
        "tipe_model": "KGRC-GX200 Gasoline Railway Cutting Machine",
        "spek": [
            ("Engine", "Honda GX200 Gasoline"),
            ("Power", "4,8 kW @ 3.600 rpm"),
            ("Cutting Wheel", "Ø400 × Ø32 × 4 mm"),
            ("Rails Applicable", "43–75 kg/m"),
            ("Cutting Time", "≤120 detik"),
        ],
        "foto_url": "https://kertz-machine.com/wp-content/uploads/2025/02/Gasoline-Railway-Cutting-Machine-KGRC-GX200.png",
        "url_spek": "https://drive.google.com/file/d/15bRgXk8Nds_IuWqZt_lwuF6Re3BRIczZ/view?usp=sharing",
    },
    {
        "kode_alat": "MPR",
        "merk": "JINZHOU TIEGONG",
        "tipe_model": "NQG-5III Rail Cutting Machine",
        "spek": [
            ("Engine", "GX270H2-E1, 4-Stroke"),
            ("Power", "6,6 kW (SAEJ 1349)"),
            ("Cutting Wheel", "Ø400 × 4 × Ø25,4 mm"),
            ("Cutting Time", "≤120 detik (rel 60 kg/m)"),
            ("Machine Weight", "53 kg"),
        ],
        "foto_url": "https://sc04.alicdn.com/kf/Hb7269ff75048461daf3718f360e07adfp.jpg",
        "url_spek": "https://drive.google.com/file/d/1Le-9cXUrCIvoacQum3jlAUhcSO6KEN-l/view?usp=sharing",
    },
    # ── WHEEL GAUGE ──
    # The Rekap heads this "WHEEL GAUGE"; the katalog has no such entry and the
    # matching spektek PDF is "Alat ukur flens roda_spektek.pdf", so it lands
    # under AUF. The gauge does measure rim thickness and wheel diameter too
    # (AUD), but one tool cannot sit under two alat kerja.
    {
        "kode_alat": "AUF",
        "merk": "WINCHESTER INDUSTRIES, INC.",
        "tipe_model": "W600-10A Metric Steel Wheel Gage",
        "spek": [
            ("Standard", "AAR"),
            ("Unit Pengukuran", "Metrik (mm)"),
            ("Pengukuran Flens", "Tinggi & lebar flens"),
            ("Pengukuran Roda", "Tebal rim & diameter roda"),
            ("Sertifikasi", "AAR Quality Assurance"),
        ],
    },
    # ── DONGKRAK (RAIL JACK) ──
    {
        "kode_alat": "DRJ",
        "merk": "ITAKE",
        "tipe_model": "INR-10 Rail Jack",
        "spek": [
            ("Lifting Capacity", "Head 10 ton / Claw 8 ton"),
            ("Lifting Stroke", "100 mm"),
            ("Claw Height", "55 mm"),
            ("Base Size", "155 × 300 mm"),
            ("Berat", "16,5 kg"),
        ],
    },
    # ── PORTABLE BALLAST TAMPER ──
    {
        "kode_alat": "PBT",
        "merk": "SIERA",
        "tipe_model": "04 Portable Ballast Tamper",
        "spek": [
            ("Engine", "Honda GX50, 2 HP (1,47 kW)"),
            ("Bahan Bakar", "Bensin/Petrol"),
            ("Kapasitas Tangki", "0,5–1,5 L"),
            ("Berat Alat", "18–22 kg"),
            ("Getaran di Dalam Balas", ">90 Hz"),
        ],
    },
    # ── HAND TIE TAMPER ──
    {
        "kode_alat": "HTT",
        "merk": "RAILMAN",
        "tipe_model": "IT-450E Tie Tamper",
        "spek": [
            ("Input Voltage", "3-Phase 200–220 V"),
            ("Rated Output", "450 W (520 W–220 V)"),
            ("Tamping Capacity", "1 tie / 20–30 detik"),
            ("No. of Vibrations", "2.800 / 3.400 min⁻¹"),
            ("Weight", "29 kg (excluding cable)"),
        ],
    },
    # ── RAIL FLAW DETECTOR ──
    {
        "kode_alat": "RFD",
        "merk": "TOKYO KEIKI",
        "tipe_model": "PRD-300 Ultrasonic Rail Flaw Detector",
        "spek": [
            ("Testing Method", "Pulse Echo"),
            ("Probe", "4 standar / 5 opsional"),
            ("Probe Angle", "0°, ±45°, +70° / ±70° opsional"),
            ("Display", '8,4" High Brightness Color LCD'),
            ("Battery Operating Time", "±5 jam"),
        ],
    },
    # ── ALAT UKUR LEBAR SEPUR ──
    {
        "kode_alat": "ALS",
        "merk": "GEISMAR",
        "tipe_model": "RCA",
        "spek": [
            ("Track Gauge Measurement Range", "1.047–1.107 mm"),
            ("Super Elevation Measurement Range", "−30 hingga +150 mm"),
            ("Track Gauge", "1.067 mm"),
            ("Berat", "2–2,5 kg"),
            ("Application", "Track & Turnout Measurement"),
        ],
        "foto_url": "https://geismar.com/wp-content/uploads/2019/02/Geismar_mesure_Rcff.jpg",
        "url_spek": "https://drive.google.com/file/d/1PCRtg7THlNgvWT8Xi-e3366tnuWf9IdC/view?usp=sharing",
    },
    # ── THERMOGUN ──
    {
        "kode_alat": "TMG",
        "merk": "KRISBOW",
        "tipe_model": "KW0600656 Infrared Thermometer",
        "spek": [
            ("Temperature Range", "−50 hingga 1.600 °C"),
            ("Accuracy", "±1,5%"),
            ("Laser Sighting", "Dual Laser"),
            ("Temperature Unit", "°C / °F"),
            ("Display", "White Backlit LCD"),
        ],
        "foto_url": "https://klg-product-service.s3.ap-southeast-3.amazonaws.com/attachments/prod/KW0600656/KW0600656_IMG_1_1/KW0600656_1.jpg",
    },
]


def MODEL_TITLE(merk: str, tipe_model: str) -> str:
    """
    The Rekap's own naming rule: "[MERK] [MODEL/TYPE]", maximum 50 characters.

    This is what becomes `alat_varian.nama_varian`, so it is also half of the
    `(kode_alat, nama_varian)` uniqueness constraint — two models of one tool
    whose names collide inside 50 characters would clash on insert.
    """
    return f"{(merk or '').strip()} {(tipe_model or '').strip()}".strip()[:50]


# ══════════════════════════════════════════════════════════════════════
# 3. EXTRA_ALAT_REMAP — repairing the alat-kerja/model confusion
# ══════════════════════════════════════════════════════════════════════
#
# Old `seed.py` code → (katalog kode_alat, model name under it).
#
# Read it as: "this thing is not an alat kerja; it is THIS model of THAT alat
# kerja". It drives two migrations at once — the `alat_varian` rows created for
# the sparepart-bearing models, and the re-pointing of SPAREPART_CATALOG's keys
# so every part still hangs off a code that exists.
#
# FOUR ENTRIES ARE OUTRIGHT CODE COLLISIONS: the old code means something else
# in the katalog, and the katalog wins.
#
#   MPR  was "MESIN POTONG/BABAT RUMPUT"   → katalog MPR is MESIN POTONG REL,
#                                             so this becomes a model of MPT
#   AUK  was "ALAT UKUR KEAUSAN REL"       → katalog AUK is ANTAR KEPING RODA,
#                                             so this becomes a model of AKR
#   STM  was "STAMPER"                     → katalog STM is MESIN STEAM,
#                                             so this becomes a model of HNS
#   MBT  was "MESIN BOR BETON"             → katalog MBT is MESIN BOR TANGAN,
#                                             which it is a model of
#
# Where the old code and the katalog agree (DSM, MBK, LMP) the row is still
# listed, so the mapping is total and no caller has to fall back.
EXTRA_ALAT_REMAP = {
    # ── models of HAND TIE TAMPER ──
    "HTT":  ("HTT", "HTT 220 V"),
    "HTTS": ("HTT", "HTT 3 PHASE"),
    "HTTG": ("HTT", "GEISMAR HTT"),
    "HTPE": ("HTT", "HTT PORTABLE"),
    # ── jacks ──
    "DKR":  ("DRJ", "DONGKRAK ANGKATAN MIN 10 TON"),
    "DKP":  ("DPL", "DONGKRAK PAL"),
    # ── trolleys: the katalog splits these by capacity already ──
    "LOR":  ("LDL", "LORI DORONG 500 KG"),
    "LOR2": ("LDD", "LORI DORONG 2 TON"),
    # ── cutting / grinding ──
    "CRL":  ("MPR", "CUTTING RAIL"),
    "MPR":  ("MPT", "MESIN POTONG/BABAT RUMPUT"),   # collision — katalog wins
    "CSW":  ("GGM", "MESIN CHAINSAW"),
    "JHM":  ("JCK", "JACK HAMMER"),
    "GRD":  ("RGM", "MESIN GERINDA MP 12"),
    "GRT":  ("MGT", "MESIN GERINDA TANGAN"),
    "BLD":  ("BLP", "BLANDER POTONG"),
    # ── welding ──
    "MST":  ("TWK", "MESIN SCRAP THERMIT"),
    "MLS":  ("MLL", "MESIN LAS"),
    # ── power & light ──
    "GEN1": ("GEN", "GENSET 1 PHASE (PENERANGAN)"),
    "LMP":  ("LMP", "LAMPU PENERANGAN / STAND"),
    # ── track work ──
    "PNP":  ("PAN", "PANPULLER"),
    "AUK":  ("AKR", "ALAT UKUR KEAUSAN REL"),       # collision — katalog wins
    "MSA":  ("AUA", "MISTAR ANGKATAN / LESTRENG"),
    "DSM":  ("DSM", "DENSOMETER STANDAR"),
    "STM":  ("HNS", "STAMPER"),                     # collision — katalog wins
    # ── drilling ──
    "MBK":  ("MBK", "MESIN BOR KAYU STANDAR"),
    "MBT":  ("MBT", "MESIN BOR BETON"),             # collision — katalog wins
}


# ══════════════════════════════════════════════════════════════════════
# 4. Legacy models carried forward
# ══════════════════════════════════════════════════════════════════════
#
# seed.py's old VARIAN_DATA, reshaped onto the label/value pairs. Every code
# here survives the katalog adoption unchanged, so these are pure model rows.
# The four old fixed columns become the first four labelled slots, which is
# exactly what the `_ensure_schema()` backfill does for a database that already
# holds them.
#
# Each entry: (kode_alat, nama_varian, merk, tipe_model, [(label, nilai), …])
LEGACY_MODEL_DATA = [
    # ── GENERATOR SET ──
    ("GEN", "GX270", "HONDA", "GX270", [("Kapasitas", "5,0 kVA"), ("Daya", "9,0 HP / 6,6 kW"), ("Dimensi", "680 x 530 x 560 mm"), ("Berat", "78 kg")]),
    ("GEN", "GX390", "HONDA", "GX390", [("Kapasitas", "6,5 kVA"), ("Daya", "13,0 HP / 9,6 kW"), ("Dimensi", "740 x 560 x 570 mm"), ("Berat", "88 kg")]),
    ("GEN", "GX200", "HONDA", "GX200", [("Kapasitas", "3,0 kVA"), ("Daya", "6,5 HP / 4,8 kW"), ("Dimensi", "600 x 450 x 490 mm"), ("Berat", "56 kg")]),
    ("GEN", "GX160", "HONDA", "GX160", [("Kapasitas", "2,2 kVA"), ("Daya", "5,5 HP / 4,0 kW"), ("Dimensi", "560 x 430 x 470 mm"), ("Berat", "48 kg")]),
    # ── MESIN BOR ──
    ("BOR", "GEISMAR", "GEISMAR", "PRM-4", [("Kapasitas", "Mata bor Ø 40 mm"), ("Daya", "1,8 kW"), ("Dimensi", "520 x 300 x 380 mm"), ("Berat", "23 kg")]),
    ("BOR", "CHINA", "TIANYU", "ZG-32", [("Kapasitas", "Mata bor Ø 32 mm"), ("Daya", "1,5 kW"), ("Dimensi", "500 x 290 x 360 mm"), ("Berat", "21 kg")]),
    ("BOR", "BDS", "BDS", "MAB-485", [("Kapasitas", "Mata bor Ø 40 mm"), ("Daya", "1,5 kW"), ("Dimensi", "480 x 280 x 400 mm"), ("Berat", "19 kg")]),
    ("BOR", "FCS PRO36RH", "FCS", "PRO36RH", [("Kapasitas", "Mata bor Ø 36 mm"), ("Daya", "1,6 kW"), ("Dimensi", "510 x 300 x 390 mm"), ("Berat", "20 kg")]),
    # ── IMPACT WRENCH ──
    ("IMP", "TW1000", "SHINANO", "TW-1000", [("Kapasitas", "Baut M24 – M30"), ("Daya", "1.100 Nm"), ("Dimensi", "420 x 200 x 240 mm"), ("Berat", "9,5 kg")]),
    ("IMP", "MILWAUKEE M18 FHIWF1", "MILWAUKEE", "M18 FHIWF1", [("Kapasitas", "Baut M20 – M27"), ("Daya", "1.017 Nm"), ("Dimensi", "249 x 104 x 250 mm"), ("Berat", "3,6 kg")]),
    ("IMP", "MAKITA", "MAKITA", "TW1000", [("Kapasitas", "Baut M22 – M30"), ("Daya", "1.050 Nm"), ("Dimensi", "268 x 105 x 258 mm"), ("Berat", "4,2 kg")]),
    # ── RAIL GRINDING MACHINE ──
    ("RGM", "GEISMAR", "GEISMAR", "MP-12", [("Kapasitas", "Batu gerinda Ø 150 mm"), ("Daya", "4,0 HP / 2,9 kW"), ("Dimensi", "1.150 x 520 x 900 mm"), ("Berat", "62 kg")]),
    ("RGM", "KANTOR PUSAT", "GEISMAR", "RGM-STD", [("Kapasitas", "Batu gerinda Ø 150 mm"), ("Daya", "4,0 HP / 2,9 kW"), ("Dimensi", "1.100 x 500 x 880 mm"), ("Berat", "60 kg")]),
    # ── TRACK GEOMETRY TROLLEY ──
    ("TGT", "GEISMAR", "GEISMAR", "TGT-2", [("Kapasitas", "Lebar sepur 1.067 mm"), ("Daya", "Baterai 12 V"), ("Dimensi", "1.200 x 1.100 x 950 mm"), ("Berat", "34 kg")]),
    ("TGT", "BANCE", "BANCE", "GJY-T", [("Kapasitas", "Lebar sepur 1.067 mm"), ("Daya", "Baterai 12 V"), ("Dimensi", "1.180 x 1.090 x 930 mm"), ("Berat", "31 kg")]),
    # ── TRACK GAUGE ──
    ("TRG", "GEISMAR", "GEISMAR", "EM-120", [("Kapasitas", "1.067 mm ± 5 mm"), ("Dimensi", "1.150 x 120 x 90 mm"), ("Berat", "5,4 kg")]),
    ("TRG", "BANCE", "BANCE", "GJC-1067", [("Kapasitas", "1.067 mm ± 5 mm"), ("Dimensi", "1.140 x 115 x 85 mm"), ("Berat", "5,1 kg")]),
    # ── ALAT UKUR ULTRASONIK ──
    ("USM", "ALUMUNIUM", "KRAUTKRAMER", "DM5E", [("Kapasitas", "Tebal 0,6 – 500 mm"), ("Daya", "Baterai 2 x AA"), ("Dimensi", "160 x 75 x 35 mm"), ("Berat", "0,35 kg")]),
    ("USM", "FIBER", "KRAUTKRAMER", "DMS Go", [("Kapasitas", "Tebal 0,6 – 500 mm"), ("Daya", "Baterai Li-Ion"), ("Dimensi", "170 x 80 x 40 mm"), ("Berat", "0,42 kg")]),
    # ── RAIL FLAW DETECTOR ──
    ("RFD", "MANUAL", "SPERRY", "UT-1", [("Kapasitas", "Kedalaman deteksi 70 mm"), ("Daya", "Baterai 12 V"), ("Dimensi", "900 x 600 x 1.050 mm"), ("Berat", "28 kg")]),
    ("RFD", "DIGITAL", "SPERRY", "RFD-500", [("Kapasitas", "Kedalaman deteksi 70 mm"), ("Daya", "Baterai Li-Ion 24 V"), ("Dimensi", "950 x 620 x 1.080 mm"), ("Berat", "32 kg")]),
    # ── PORTABLE BALLAST TAMPER ──
    ("PBT", "2T TASCO", "TASCO", "TCM-25", [("Kapasitas", "Kedalaman 250 mm"), ("Daya", "2,2 HP / 1,6 kW"), ("Dimensi", "1.050 x 350 x 400 mm"), ("Berat", "26 kg")]),
    ("PBT", "4T PROQUIP", "PROQUIP", "PQ-40", [("Kapasitas", "Kedalaman 250 mm"), ("Daya", "4,0 HP / 2,9 kW"), ("Dimensi", "1.080 x 360 x 410 mm"), ("Berat", "31 kg")]),
    ("PBT", "4T HONDA", "HONDA", "GX120 TAMPER", [("Kapasitas", "Kedalaman 250 mm"), ("Daya", "4,0 HP / 2,9 kW"), ("Dimensi", "1.070 x 355 x 405 mm"), ("Berat", "30 kg")]),
]


def spek_columns(pairs) -> dict:
    """
    [(label, nilai), …] → {"spek1_label": …, "spek1_nilai": …, …}

    Slots beyond the supplied pairs are explicitly set to None so an UPDATE
    through this helper CLEARS a slot that used to hold something, rather than
    leaving a stale row from a previous spec behind. Anything past five pairs is
    dropped — the template is fixed at five and silently growing it would put
    values on screen that no form can edit.
    """
    out = {}
    for i in range(1, 6):
        label, nilai = (pairs[i - 1] if i <= len(pairs) else (None, None))
        out[f"spek{i}_label"] = label
        out[f"spek{i}_nilai"] = nilai
    return out


def iter_all_models():
    """
    Every model row to seed, as a uniform dict, from all three sources.

    Yields: {kode_alat, nama_varian, merk, tipe_model, spek1_label…spek5_nilai,
             foto_url, url_spek, keterangan}
    """
    for m in MODEL_DATA:
        yield {
            "kode_alat": m["kode_alat"],
            "nama_varian": MODEL_TITLE(m["merk"], m["tipe_model"]),
            "merk": m["merk"],
            "tipe_model": m["tipe_model"],
            "foto_url": m.get("foto_url"),
            "url_spek": m.get("url_spek"),
            "url_manual": m.get("url_manual"),
            "keterangan": None,
            **spek_columns(m["spek"]),
        }

    for kode, nama, merk, tipe, pairs in LEGACY_MODEL_DATA:
        yield {
            "kode_alat": kode,
            "nama_varian": nama,
            "merk": merk,
            "tipe_model": tipe,
            "foto_url": None,
            "url_spek": None,
            "url_manual": None,
            "keterangan": None,
            **spek_columns(pairs),
        }

    # The remapped ex-alat-kerja. These carry no spec block — the Rekap has no
    # entry for them — so they seed as name-only models, visibly incomplete in
    # Pusat Data ▸ Model/Type rather than silently absent.
    for old_kode, (kode, nama) in EXTRA_ALAT_REMAP.items():
        yield {
            "kode_alat": kode,
            "nama_varian": nama,
            "merk": None,
            "tipe_model": nama,
            "foto_url": None,
            "url_spek": None,
            "url_manual": None,
            "keterangan": f"Dipetakan dari kode lama '{old_kode}'.",
            **spek_columns([]),
        }


# ══════════════════════════════════════════════════════════════════════
# 5. ALAT KERJA NOT IN THE KATALOG
# ══════════════════════════════════════════════════════════════════════
#
# `BKC` appears 39 times in `Template_Import_Aset_RAMCES.xlsx ▸ Data Aset JB`
# with the model "SSPC VIS 3", and the katalog's own side-column lists it as
# "Tidak Ditemukan" — the client could not place it. Dropping it would silently
# discard 39 real assets, so it is seeded here, OUTSIDE `KATALOG_ALAT`, with a
# name inferred from the model and the matching `Spesifikasi SSPC VIS 3.pdf` in
# `modules/`. Move it into KATALOG_ALAT once the client confirms the name.
KATALOG_TAMBAHAN = [
    ("BKC", "STANDAR VISUAL SSPC VIS 3", False, False, "JEMBATAN"),
]

ALL_ALAT = KATALOG_ALAT + KATALOG_TAMBAHAN
ALL_KODE = {row[0] for row in ALL_ALAT}


# ══════════════════════════════════════════════════════════════════════
# 6. UPT / RESORT — KATALOG SFM.xlsx ▸ KATALOG UPT
# ══════════════════════════════════════════════════════════════════════
#
# 254 rows. The hand-kept list this replaced had 240 and was missing the entire
# MEKANIK branch — ME1.1, ME1.2, ME2..ME9, MEI..MEIV — which meant 14 real
# resorts existed in the client's katalog and nowhere in RAMCES. That is the
# same shape of hole the JB branch was in before rev0.5.0, found the same way:
# by finally comparing the database against the file.
#
# Codes are whitespace-stripped by the reader ("JB1.3 " carries a trailing
# space) because `id_lokasi` is compared by exact equality everywhere and a
# stray one makes a resort unreachable.
#
# Columns: (id_lokasi, nama_lokasi, parent_code). `parent_code` is
# INFORMATIONAL: the hierarchy is derived from the id by
# `get_parent_lokasi_code()` and never stored. It is kept so
# `verify_upt_parents()` below can assert that the derivation and the sheet
# agree on all 254 rows.
KATALOG_UPT = [
    (kode, nama, parent_kode)
    for kode, nama, parent_kode, _parent_nama, _unit in _sfm().upt
]

# The sheet's own UNIT column, keyed by code. It maps 1:1 onto the code prefix
# (JR / JB / ME), which is what makes deriving an asset's peruntukan from its
# location a derivation rather than a guess — see peruntukan_dari_lokasi().
KATALOG_UPT_UNIT = {
    kode: unit for kode, _n, _pk, _pn, unit in _sfm().upt
}


def verify_upt_parents(get_parent):
    """
    Assert every UPT's stored parent equals the one derived from its id.

    The hierarchy lives in the id string and in nothing else, so a resort whose
    code does not parse is invisible to every regional filter and scope check
    while still looking perfectly fine in the master table. This is exactly how
    the JB branch went unnoticed. `seed.py` calls this on every run.

    Returns the list of mismatches; empty means the tree is sound.
    """
    bad = []
    for kode, nama, parent in KATALOG_UPT:
        derived = get_parent(kode)
        if derived != parent:
            bad.append((kode, nama, parent, derived))
    return bad
