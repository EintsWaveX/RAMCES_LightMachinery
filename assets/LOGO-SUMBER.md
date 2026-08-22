# Sumber logo

`logo_kai.svg` dan `logo_bumn.svg` diunduh dari Wikimedia Commons pada 21 Agustus 2026
untuk dipakai pada kop (banner) Dashboard.

| Berkas | Sumber | Ukuran asli | Warna |
|---|---|---|---|
| `logo_kai.svg` | https://commons.wikimedia.org/wiki/File:Logo_PT_Kereta_Api_Indonesia_(Persero)_2020.svg | viewBox 294.74 × 124.22 | `#2d2a70` navy, `#ed6b23` oranye |
| `logo_bumn.svg` | https://commons.wikimedia.org/wiki/File:Logo_BUMN_Untuk_Indonesia_2020.svg | 164.84 × 29.53 mm | `#1c2954` navy, `#25a0ab` tosca |

`logo_kai_putih.svg` dan `logo_bumn_putih.svg` adalah varian *knockout* putih dari kedua
berkas di atas — setiap `fill` diganti `#ffffff`, tidak ada perubahan bentuk. Keduanya ada
karena kedua logo asli berwarna gelap: di atas latar `--kai-blue` maupun di mode gelap,
versi berwarna tidak terbaca sama sekali. Memakai versi putih resmi adalah praktik brand
yang benar; membalik warna logo dengan filter CSS (`brightness-0 invert`) tidak.

**Jangan menimpa `logo_nav.svg` atau `logo_login.svg`.** Keduanya adalah wordmark KAI yang
sudah dipakai sidebar, halaman login dan `landing.html`. Middleware Cache-Control menstempel
gambar `max-age=31536000, immutable`, sehingga berkas yang ditimpa akan tetap tercache
selama setahun di peramban yang sudah pernah memuatnya — selalu pakai nama berkas baru.
