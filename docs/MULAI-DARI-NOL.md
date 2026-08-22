# Mulai dari Nol, RAMCES

Panduan menyiapkan RAMCES dari **database kosong** sampai bisa dipakai, memakai
tools yang sudah ada di direktori ini. Tidak ada langkah yang butuh unduhan baru.

Perkiraan waktu: **di bawah 5 menit**. Langkah `seed` sendiri diukur **9 detik**
dari database benar-benar kosong sampai 16/16 verifikasi lulus, 1.121 aset,
273 lokasi, 203 sparepart dan 33 dokumen. Sisanya adalah mengetik `.env`.

---

## 0. Prasyarat

| Yang dibutuhkan | Kenapa | Cek |
|---|---|---|
| **Python 3.10** | Hanya versi ini yang punya dependensinya. `python` di PATH menunjuk 3.14 dan akan gagal `ModuleNotFoundError`. **Selalu `py -3.10`.** | `py -3.10 --version` |
| **PostgreSQL berjalan** | Satu-satunya penyimpanan. | `psql -l` atau cek servisnya |
| **Folder `modules/`** | Drop sumber dari klien: katalog, workbook impor, PDF spektek/manual. **Dependensi keras**, bukan tambahan opsional, `seed_katalog.py` sengaja RAISE tanpa itu, karena perilaku lama (import diam-diam lalu katalog kosong) membuat impor aset melewati semua 1.121 baris sambil melapor sukses. | `ls modules/` |

`modules/` tidak ikut git (±41 MB). Salin dari drive tim sebelum mulai.

Tanpa `modules/`, aplikasi tetap **boot dan melayani UI**, hanya tidak bisa
di-seed.

---

## 1. Buat database kosong

```bash
psql -U postgres -c "CREATE DATABASE warehouse_monitoring;"
```

Namanya bebas, asal cocok dengan `DATABASE_URL` di langkah berikutnya. Tabel
**tidak** perlu dibuat manual: `models.Base.metadata.create_all()` membuatnya
saat pertama kali `manage.py` atau aplikasi dijalankan.

---

## 2. Siapkan `.env`

```bash
cp .env.example .env
```

Lalu isi dua nilai yang **wajib**. Keduanya tidak punya fallback dan aplikasi
menolak boot tanpanya, sengaja:

```ini
DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/warehouse_monitoring
SECRET_KEY=<hasil perintah di bawah>
```

```bash
py -3.10 -c "import secrets; print(secrets.token_urlsafe(48))"
```

> **Kenapa tidak boleh ada fallback.** `SECRET_KEY` dulu jatuh ke konstanta yang
> tertulis di `main.py`. Artinya siapa pun yang memegang file itu bisa mencetak
> token `SUPER_ADMIN` sendiri tanpa pernah memanggil `/api/login`. `DATABASE_URL`
> dulu jatuh ke URL lokal yang memuat password sungguhan di file ter-track.

Opsional tapi disarankan untuk instalasi pertama, kalau dikosongkan, seeder
membuat password acak dan **mencetaknya SEKALI** (tidak bisa dilihat lagi):

```ini
BOOTSTRAP_ADMIN_USERNAME=superadmin
BOOTSTRAP_ADMIN_PASSWORD=<password kuat pilihan Anda>
```

Isi `TRUSTED_PROXY=1` **hanya** kalau ada ngrok / Tailscale / nginx di depan
aplikasi. Tanpa proxy, header `X-Forwarded-For` bisa dikarang penyerang dan
batas rate per-IP jadi hiasan belaka.

---

## 3. Isi database

```bash
py -3.10 manage.py seed
```

Berjalan berurutan, **urutannya penting**:

```
katalog → dokumen → model → aset → inventaris → pengguna
```

`alat_varian` harus ada sebelum impor aset (tiap baris workbook menyebut
modelnya sebagai teks bebas yang di-resolve ke tabel itu), dan `dokumen` jalan
lebih awal karena menulis ke `kategori_alat`, yang lalu diwarisi baris model.

Setiap langkah **idempoten**: menjalankan dua kali tidak mengubah apa pun yang
kedua. Verifikasi otomatis berjalan di akhir; kalau ada yang gagal, exit code
bukan nol.

Yang seharusnya Anda lihat:

```
✓ kategori_alat = 104
✓ lokasi = 273 (16 induk + 257 UPT)
✓ hierarki UPT: 254 kode resolve ke induk yang benar
✓ aset nyata = 1121 (sesuai workbook)
✓ setiap berkas di uploads/dokumen_alat/ terjangkau (33 berkas)
✓ ada SUPER_ADMIN yang bisa masuk
✓ VERIFIKASI LULUS, 16 pemeriksaan.
```

**Catat username dan password `SUPER_ADMIN`** dari keluaran langkah `pengguna`.
Login tidak mendaftarkan akun baru secara otomatis, jadi itu satu-satunya jalan
masuk sampai admin membuat atau menyetujui akun lain.

### Kalau ingin dashboard perbaikan ada isinya

Dashboard Perbaikan, Kurva MCF, dan Laporan Perbaikan akan **KOSONG** setelah
seed biasa, itu benar, bukan bug: armada yang diimpor **nyata**, dan riwayat
perbaikan karangan terhadapnya tidak bisa dibedakan dari fakta setahun lagi.

Untuk demo, tambahkan 100 aset contoh berikut simulasi riwayatnya:

```bash
py -3.10 manage.py seed --only dummy --with-history
```

Aset contoh diberi `nomor_seri` berawalan `DEMO-`, jadi selalu bisa dibedakan
dan dihapus. `--aset N` mengubah **target populasi**, bukan jumlah yang
ditambahkan, menjalankannya dua kali tidak menggandakan apa pun.

### Kalau ingin SELURUH armada nyata punya riwayat

Cara di atas hanya mengisi 100 aset contoh. Untuk membuat dashboard benar-benar
representatif, sebaran per DAOP nyata, campuran alat kerja nyata, jalankan:

```bash
py -3.10 manage.py seed --simulasi
```

Ini menulis riwayat kondisi, mutasi, kalibrasi dan pemakaian sparepart untuk
**setiap aset yang belum punya**, termasuk 1.121 aset nyata. Hasilnya kira-kira
**85% SO · 11% TSO · 4% AFKIR**, angka yang wajar untuk armada perawatan jalan
rel.

> **Semua barisnya DITANDAI.** Setiap baris diatasnamakan pengguna `SIMULASI`
> (yang tidak bisa dipakai masuk) dan diberi awalan `[SIMULASI]` pada
> keterangannya, jadi di layar Pantau Riwayat jelas terlihat mana fakta hasil
> impor dan mana ilustrasi. `manage.py status` menghitungnya terpisah.

Menghapusnya lagi mengembalikan basis data **persis** seperti semula, jumlah
baris, status, dan lokasi setiap aset:

```bash
py -3.10 manage.py hapus-simulasi
```

---

## 4. Jalankan aplikasi

```bash
py -3.10 -m uvicorn main:app --reload
```

Buka <http://127.0.0.1:8000> dan masuk dengan akun dari langkah 3.

API dan SPA satu origin, tidak ada dev server terpisah. `GET /` mengembalikan
`index.html`, dan catch-all melayani berkas statis dari root proyek.

---

## 5. Pastikan semuanya benar (opsional, tapi murah)

Harness verifikasi ada di dalam repo. Sebagian butuh aplikasi hidup di port
8017:

```bash
py -3.10 -m uvicorn main:app --port 8017     # terminal terpisah

.\tools\verify\gate.ps1                      # rute, OpenAPI, invarian
py -3.10 tools\verify\smoke.py               # 26 endpoint baca
py -3.10 tools\verify\mutate.py              # jalur tulis, lalu bersih-bersih
py -3.10 tools\verify\coverage.py            # modules/ → DB, baris per baris
py -3.10 manage.py verify                    # 16 pemeriksaan seed
```

Tanpa aplikasi hidup, tiga pemeriksa statis tetap jalan dan murah:

```bash
py -3.10 tools\check_js.py        # js/, duplikasi deklarasi & urutan eval
py -3.10 tools\check_html.py      # index.html, 5 invarian
py -3.10 tools\check_py_names.py  # main.py + api/, nama global tak ter-resolve
```

Detail lengkap: [tools/verify/README.md](../tools/verify/README.md).

---

## 6. Kalau perlu mengulang dari nol

```bash
py -3.10 manage.py reset
```

**MERUSAK dan tidak bisa dibatalkan.** Menghapus setiap aset, riwayat kondisi,
mutasi, kalibrasi, pergerakan stok, dan akun pengguna. Meminta Anda mengetik
`RESET` secara harfiah; `--yes` melewati konfirmasi itu.

Berkas di `uploads/` **tidak** disentuh. Baris yang merujuknya hilang, jadi
berkas itu jadi yatim di disk, hapus manual kalau ingin benar-benar bersih,
atau biarkan dan jalankan `manage.py seed --only dokumen` lagi.

---

## Ringkasan perintah

```bash
psql -U postgres -c "CREATE DATABASE warehouse_monitoring;"
cp .env.example .env                      # isi DATABASE_URL + SECRET_KEY
py -3.10 manage.py seed
py -3.10 -m uvicorn main:app --reload
```

| Perintah | Fungsi |
|---|---|
| `manage.py seed` | Isi / tambal. Tidak menghapus apa pun. |
| `manage.py seed --only <langkah>` | Jalankan satu langkah saja. |
| `manage.py seed --with-history` | + 100 aset contoh & simulasi riwayat. |
| `manage.py list` | Daftar langkah yang tersedia. |
| `manage.py verify` | Periksa tanpa menulis. |
| `manage.py status` | Jumlah baris per tabel. |
| `manage.py seed --simulasi` | + riwayat simulasi BERTANDA untuk semua aset. |
| `manage.py hapus-simulasi` | Hapus riwayat simulasi, pulihkan kondisi awal. |
| `manage.py reset` | **HAPUS SEMUA**, buat ulang, semai dari nol. |

---

## Masalah yang sering muncul

| Gejala | Sebab | Solusi |
|---|---|---|
| `ModuleNotFoundError: fastapi` | Memakai `python`, bukan `py -3.10` | Pakai `py -3.10` |
| Boot gagal menyebut `DATABASE_URL` / `SECRET_KEY` | `.env` belum ada atau kosong | Langkah 2 |
| `seed` menyebut `modules/` tidak ada | Drop klien belum disalin | Salin `modules/` |
| Dashboard perbaikan & Kurva MCF kosong | **Benar**, armada nyata belum punya riwayat | `--simulasi` (seluruh armada) atau `--with-history` (100 aset contoh) |
| Ada baris riwayat bertanda `[SIMULASI]` | Data ilustrasi, bukan fakta | `manage.py hapus-simulasi` menghapusnya persis |
| Tab Kalibrasi tidak muncul di sebagian aset | **Benar**, digerakkan `kategori_alat.perlu_kalibrasi`. Genset diservis, bukan dikalibrasi | Bukan bug |
| Akun lama tidak bisa masuk | Baris yang di-seed sebelum autentikasi punya `hashed_password` NULL | Pusat Data ▸ Pengguna menandainya; setel password dari sana |
| "Captcha" muncul saat login | Batas percobaan tersentuh. **Bukan penguncian**, akun tetap bisa masuk | Isi captcha; login berhasil mereset hitungannya |
