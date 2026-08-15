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

**Catatan "admin daerah hanya input pengadaan 2".** Ditegakkan di server:
`assert_region_scope()` membatasi `ADMIN_WILAYAH` ke wilayahnya sendiri pada
create/edit/delete/mutasi/kondisi/kalibrasi. Pembatasan **`sumber_pengadaan`
ke DAOP/DIVRE saja** untuk peran itu belum ada — form-nya masih menawarkan
PUSAT. Ini satu baris di `create_aset`/`update_aset` dan layak dikonfirmasi ke
klien dulu (apakah larangan keras, atau sekadar default).

---

## B. Part Inventory

| # | Submenu | Status | Di mana / catatan |
|---|---|---|---|
| 1 | Daftar Stok | ✅ | Kelola Inventaris ▸ Sparepart. `GET /api/inventaris/parts` |
| 2 | Export stok | ✅ | Excel, sisi klien |
| 3 | Input Pembelian | ✅ | Form pergerakan, tipe `IN` |
| 4 | History Card Part — cari part number/nama | ✅ | Pencarian sparepart |
| 5 | History Card Part — timeline transaksi | ⚠️ | Datanya lengkap: `GET /api/inventaris/stok?id_part=N` mengembalikan buku besar per part, dan `sparepart_stok` memang append-only. Yang belum ada adalah **kartu riwayat per part** sebagai layar tersendiri — sekarang riwayat dibaca dari tab Transaksi yang difilter |
| 6 | **Hierarki Part — Tree / struktur BOM per jenis alat** | ❌ | Belum ada. Relasinya sebagian sudah tersimpan (`sparepart.kode_alat`, `sparepart.id_varian`, `sparepart_kategori.subsistem`), jadi pohon dua tingkat *alat kerja → kategori/subsistem → part* bisa dibangun dari data yang ada tanpa skema baru |
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
| **Riwayat kalibrasi dan reminder** | ⚠️ | Riwayat ✅ dan `tanggal_berlaku` tersimpan, badge "BLM KALIBRASI" ada. **Reminder aktif** (notifikasi jatuh tempo) ❌ |
| Persebaran alat kerja & status | ✅ | |
| Monitoring availability alat | ✅ | Grafik Ketersediaan |
| Grafik frekuensi kerusakan & riwayat resort | ✅ | |
| **Analisis Reliability (MTBF, MTTR)** | ❌ | Kurva MCF ada; MTBF/MTTR tidak. Datanya cukup — `riwayat_kondisi` mencatat setiap masuk/keluar keadaan TSO dengan cap waktu — jadi ini perhitungan baru, bukan skema baru |
| Laporan data & kondisi alat | ✅ | |
| Laporan pemeliharaan | ✅ | |
| Export Excel/PDF | ✅ | |

### Inventory Management System

| Klaim poster | Status | Catatan |
|---|---|---|
| Data master sparepart | ✅ | |
| Hirarki & kategori sparepart | ⚠️ | Kategori ✅ (45 baris, plus `subsistem`). Hirarki sebagai **pohon** ❌ — lihat B-6 |
| Lokasi penyimpanan | ✅ | `gudang`, sengaja datar dan lepas dari pohon DAOP/UPT |
| Harga & spesifikasi sparepart | ✅ | |
| Inbound dan Outbound Part | ✅ | `IN` / `OUT` |
| Pembelian dan **Stock Adjustment** | ✅ | `ADJ_IN` / `ADJ_OUT`, plus `RETUR_VENDOR` / `RETUR_CUST` |
| Minimum stock part | ✅ | `sparepart.stok_min` + `_stok_status()` |
| Integrasi pemeliharaan alat | ✅ | `pemakaian_sparepart`, satu transaksi dengan laporan kondisi |
| **Fast Moving & Slow Moving** | ❌ | `monthly_usage` sudah dihitung di dashboard inventaris, jadi klasifikasinya adalah lapisan di atas data yang sudah ada |
| Critical Part Analysis | ✅ | `critical_count` / `critical_list`, diturunkan dari stok vs `stok_min` — tidak disimpan sebagai boolean, karena part yang stoknya aman bukan part kritis |
| Minimum stock part | ✅ | |
| Nilai persediaan | ✅ | `total_value`, `top_value` |
| Laporan stok & **stock opname** | ⚠️ | Laporan stok ✅. **Opname** (hitung fisik → selisih → penyesuaian) ❌, meski `ADJ_IN`/`ADJ_OUT` sudah jadi mekanisme penyesuaiannya |
| Laporan transaksi & pemakaian | ✅ | |
| Laporan nilai gudang | ✅ | |
| Export Excel/PDF | ✅ | |

---

## Ringkasan yang belum ada

Diurutkan menurut biaya bangun terhadap manfaat, dan semuanya bisa dikerjakan
**tanpa perubahan skema** kecuali yang ditandai:

1. **Hierarki Part (BOM tree)** — B-6, satu-satunya baris "High" di matriks klien
   yang belum ada sama sekali. Dua tingkat dari kolom yang sudah tersimpan.
2. **MTBF / MTTR** — perhitungan atas `riwayat_kondisi` yang sudah lengkap.
   Melengkapi Kurva MCF pada tab yang sama.
3. **Kartu riwayat per part** — endpointnya sudah ada, tinggal layarnya.
4. **Fast/Slow moving** — klasifikasi atas `monthly_usage` yang sudah dihitung.
5. **Stock opname** — perlu satu tabel sesi opname; `ADJ_IN`/`ADJ_OUT` sudah
   menjadi jalur penyesuaiannya.
6. **Reminder kalibrasi** — `tanggal_berlaku` sudah tersimpan; yang belum ada
   adalah mekanisme pemberitahuannya.
7. **Tombol scan QR in-app** — A-8. Butuh izin kamera di browser; alur lapangan
   sudah berjalan tanpanya.

Tidak ada di daftar ini yang menghalangi alur integrasi utama.
