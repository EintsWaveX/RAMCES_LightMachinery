# Cakupan terhadap TIMELINE MAGANG — Modul

Pemetaan baris-per-baris dari matriks fitur klien (`TIMELINE MAGANG - Modul.pdf`)
ke apa yang **benar-benar ada di kode hari ini**, diperiksa terhadap endpoint dan
view yang berjalan — bukan terhadap ingatan.

Status: **✅ ada** · **⚠️ sebagian** (data ada, permukaan UI belum penuh) ·
**❌ belum ada**.

---

## Alur integrasi yang diminta

> Input Alat → Generate QR → Scan QR → Landing Page → Form Perbaikan →
> Input Sparepart → Outbound Inventory → Update Stock → History Card Alat

**Rantai ini utuh dan bisa dijalankan ujung ke ujung.** Satu titik perlu
diperjelas: "Scan QR" dilakukan oleh aplikasi kamera bawaan ponsel, yang membuka
`landing.html?uid=<id_aset>`. Tidak ada tombol pemindai di dalam aplikasi
(lihat A-8).

Bagian "Form Perbaikan → Input Sparepart → Outbound → Update Stock" adalah
**satu transaksi tunggal**: `POST /api/perbaikan` menerima array `pemakaian`
pada body yang sama dengan laporan kondisi. Stok kurang akan me-*rollback*
laporan kondisinya juga — bukan mencatat perbaikan yang tidak mengkonsumsi apa
pun, dan bukan mengambil sparepart untuk laporan yang gagal.

---

## A. Monitoring Alat Kerja

| # | Submenu | Status | Di mana / catatan |
|---|---|---|---|
| 1 | Daftar Aset — ID, nama, DAOP, SO/TSO, filter | ✅ | Kelola Data Aset. `GET /api/aset` dengan envelope `{total, limit, offset, items}` |
| 2 | QR Code — tampil + tombol cetak | ✅ | Modal QR per aset, cetak & unduh label |
| 3 | Export Daftar Aset ke Excel | ✅ | Dibangun di sisi klien (SheetJS, dimuat on-demand) |
| 5 | Input Alat — satuan | ✅ | KDAK ▸ Tambah Aset, stepper dengan pratinjau `id_aset` langsung |
| 6 | Bulk input — import Excel | ✅ | KDAK ▸ Impor Massal |
| 7 | Edit Alat | ✅ | KDAK ▸ Edit, form identik dengan Tambah |
| 8 | **Tombol scan QR** | ❌ | Tidak ada pemindai in-app. Alurnya tetap jalan lewat kamera bawaan, dan itu justru yang dilakukan teknisi di lapangan — tapi tombolnya memang belum ada |
| 9 | Dashboard — monitoring kondisi aset | ✅ | 6 tab: Matriks Kesiapan, Grafik Ketersediaan, Tren, Sebaran, Laporan Perbaikan, Kurva MCF |
| 10 | Export laporan — Excel/PDF | ✅ | Proses Laporan; pemeliharaan, kalibrasi, mutasi |

**Catatan "admin daerah hanya input pengadaan 2".** ✅ Ditegakkan penuh sejak
rev0.4.3. `assert_region_scope()` membatasi `ADMIN_WILAYAH` ke wilayahnya sendiri
pada create/edit/delete/mutasi/kondisi/kalibrasi, dan `assert_pengadaan_scope()`
menolak `sumber_pengadaan = PUSAT` dari peran itu dengan **400** — baik saat
membuat maupun mengedit. Ini larangan keras, bukan default: `sumber_pengadaan`
ikut membentuk primary key gabungan, jadi nilai yang salah bukan masalah tampilan
yang bisa diperbaiki nanti. Di sisi klien radio PUSAT disembunyikan **dan**
dinonaktifkan untuk peran itu.

---

## B. Part Inventory

| # | Submenu | Status | Di mana / catatan |
|---|---|---|---|
| 1 | Daftar Stok | ✅ | Kelola Inventaris ▸ Sparepart. `GET /api/inventaris/parts` |
| 2 | Export stok | ✅ | Excel, sisi klien |
| 3 | Input Pembelian | ✅ | Form pergerakan, tipe `IN` |
| 4 | History Card Part — cari part number/nama | ✅ | Pencarian sparepart |
| 5 | History Card Part — timeline transaksi | ✅ | **Kartu Riwayat Suku Cadang** (rev0.4.3). Dibuka dari pohon hierarki dan dari baris Daftar Suku Cadang. Berisi identitas, saldo **per gudang**, dan lini masa pergerakan. Jumlah barisnya dicocokkan persis dengan `GET /api/inventaris/stok?id_part=N` |
| 6 | **Hierarki Part — Tree / struktur BOM per jenis alat** | ✅ | **Hierarki Suku Cadang** (rev0.4.3), tab kelima di Kelola Inventaris. `GET /api/inventaris/hirarki`. Pemilihnya hanya memuat 17 alat kerja yang benar-benar punya sparepart — menawarkan 104 akan membuat 87 pilihan menghasilkan pohon kosong — dan cakupan itu dinyatakan di layar. Klik part membuka kartu riwayatnya |
| 7 | Dashboard Part | ✅ | `GET /api/inventaris/dashboard` |

---

## Poster RAMCES (halaman 2)

### Asset Management System

| Klaim poster | Status | Catatan |
|---|---|---|
| Input alat kerja (pengadaan) | ✅ | |
| Pengelolaan aset alat kerja | ✅ | |
| Data & spesifikasi alat kerja | ✅ | Blok Model/Type mengikuti template `Rekap Spek RAMCES.docx` |
| Generate & cetak QR Code | ✅ | |
| Form pemeliharaan & kalibrasi | ✅ | Form kalibrasi digerakkan `kategori_alat.perlu_kalibrasi` — genset diservis, bukan dikalibrasi |
| Riwayat pemeliharaan & penggantian sparepart | ✅ | |
| **Riwayat kalibrasi dan reminder** | ✅ | rev0.4.6. `GET /api/kalibrasi/jatuh-tempo` + badge `JATUH TEMPO`/`SEGERA` di kartu, filter "hanya yang jatuh tempo" di tab Kalibrasi, dan satu entri tetap di lonceng. Dibuat sebagai **keadaan**, bukan notifikasi — jadi tidak perlu tabel notifikasi dan tidak ada yang perlu ditandai "sudah dibaca" |
| Persebaran alat kerja & status | ✅ | |
| Monitoring availability alat | ✅ | Grafik Ketersediaan |
| Grafik frekuensi kerusakan & riwayat resort | ✅ | |
| **Analisis Reliability (MTBF, MTTR)** | ✅ | rev0.4.6. Dua kolom tambahan pada window scan yang sudah ada (`lag(waktu_lapor)` di samping `lag(kondisi)`), ditampilkan sebagai tile di panel Kurva MCF — MCF/MTBF/MTTR satu cerita keandalan. Diverifikasi dengan menghitung ulang keduanya dari `riwayat_kondisi` di Python |
| Laporan data & kondisi alat | ✅ | |
| Laporan pemeliharaan | ✅ | |
| Export Excel/PDF | ✅ | |

### Inventory Management System

| Klaim poster | Status | Catatan |
|---|---|---|
| Data master sparepart | ✅ | |
| Hirarki & kategori sparepart | ✅ | Kategori (45 baris, plus `subsistem`) dan **pohon** — lihat B-6 |
| Lokasi penyimpanan | ✅ | `gudang`, sengaja datar dan lepas dari pohon DAOP/UPT |
| Harga & spesifikasi sparepart | ✅ | |
| Inbound dan Outbound Part | ✅ | `IN` / `OUT` |
| Pembelian dan **Stock Adjustment** | ✅ | `ADJ_IN` / `ADJ_OUT`, plus `RETUR_VENDOR` / `RETUR_CUST` |
| Minimum stock part | ✅ | `sparepart.stok_min` + `_stok_status()` |
| Integrasi pemeliharaan alat | ✅ | `pemakaian_sparepart`, satu transaksi dengan laporan kondisi |
| **Fast Moving & Slow Moving** | ✅ | **Perputaran Suku Cadang** (rev0.4.3) di dasbor inventaris. Tersil atas konsumsi 12 bulan terakhir; periodenya dinyatakan di panel. Ember ketiga bernama **Tanpa Pergerakan**, bukan *dead stock* — suku cadang untuk mesin yang jarang rusak sedang menjalankan tugasnya |
| Critical Part Analysis | ✅ | `critical_count` / `critical_list`, diturunkan dari stok vs `stok_min` — tidak disimpan sebagai boolean, karena part yang stoknya aman bukan part kritis |
| Minimum stock part | ✅ | |
| Nilai persediaan | ✅ | `total_value`, `top_value` |
| Laporan stok & **stock opname** | ✅ | rev0.4.6. Tab **Stock Opname** di Kelola Inventaris: buka lembar per gudang → hitung fisik → selisih diposting sebagai `ADJ_IN`/`ADJ_OUT` dalam **satu transaksi**. Selisih dihitung terhadap stok **saat posting**, bukan snapshot saat lembar dibuka |
| Laporan transaksi & pemakaian | ✅ | |
| Laporan nilai gudang | ✅ | |
| Export Excel/PDF | ✅ | |

---

## Ringkasan — matriks klien tertutup di rev0.4.6

**rev0.4.3 menutup empat dari tujuh**: Hierarki Part (B-6, satu-satunya baris
"High" yang belum ada sama sekali), Kartu Riwayat Part (B-5), Fast/Slow moving,
dan aturan pengadaan untuk ADMIN_WILAYAH.

**rev0.4.6 menutup tiga sisanya.** Yang tersisa hanya satu baris, dan itu
disengaja:

1. **Tombol scan QR in-app** — A-8. Butuh izin kamera di browser, sementara alur
   lapangan sudah berjalan tanpanya: teknisi memindai dengan kamera bawaan
   ponsel, yang langsung membuka `landing.html?uid=…`. Nilainya kecil
   dibandingkan biayanya.

Tidak ada di daftar ini yang menghalangi alur integrasi utama.

### Catatan: dua di antaranya dulu terhalang DATA, bukan kode

MTBF/MTTR dan reminder kalibrasi sempat tercatat sebagai ⛔ *terhalang data*.
Armada nyata punya 0 catatan perbaikan dan 0 catatan kalibrasi, jadi keduanya
akan tampil 0,0 — dan menampilkan metrik keandalan yang berbunyi nol mengajari
pengguna untuk mengabaikan panel itu, perhatian yang sulit direbut kembali.

`seeds/simulasi.py` (rev0.4.4) yang membuka jalannya: riwayat operasional yang
**ditandai** atas nama akun `SIMULASI`, diberi label `[SIMULASI]`, dan bisa
dihapus persis seperti semula dengan `manage.py hapus-simulasi`. Datanya cukup
kaya untuk membangun dan MELIHAT metriknya, tanpa satu baris pun menyamar
sebagai catatan teknisi sungguhan.

### Bagaimana ketiganya diverifikasi

`tools/verify/test_rev046.py`, 24 pemeriksaan, dijalankan terhadap basis data
ber-`--simulasi` dan membersihkan setiap barisnya sendiri:

- MTBF/MTTR dihitung ulang dengan menelusuri `riwayat_kondisi` di Python murni
  lalu dibandingkan dengan endpoint — angka keandalan yang masuk akal tapi salah
  lebih buruk daripada tidak ada;
- identitas `masuk == selesai + diafkir + sedang` tetap berlaku;
- daftar jatuh tempo, gerbang tab Kalibrasi, dan badge di kartu wajib menyebut
  **aset yang sama**;
- opname dijalankan penuh — termasuk kasus yang paling mudah salah dan tidak
  terlihat pada uji yang tenang: **sparepart keluar SAAT lembar hitung terbuka**,
  yang penyesuaiannya harus diukur terhadap saldo saat ini.
