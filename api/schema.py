"""
The migration mechanism.

`models.Base.metadata.create_all()` creates missing TABLES but never ALTERs an
existing one, and there is no Alembic in this project. `_ensure_schema()` is
what stands in for it: a list of idempotent, IF NOT EXISTS-guarded DDL
statements run on every boot, each in its own transaction so one failure does
not roll back the rest.

When adding a column or an index to an existing table, add it to models.py AND
append the matching statement here, or every already-populated database will
silently lack it.

The function is DEFINED here but still CALLED from main.py, at the same point in
the module body it has always occupied — right after create_all() and before the
FastAPI app is constructed. Running the DDL as an import side effect of this
module would make import order load-bearing and hide the trigger from the call
site. It must keep running before anything queries: two of its statements
normalise `status_terakhir` and `kondisi` to upper case, and `get_all_aset` and
`export_mutasi` compare those columns raw so their declared indexes stay usable.
"""

from sqlalchemy import text as sa_text

from database import engine


def _ensure_schema():
    """
    Idempotent DDL for databases created before these columns/indexes existed.

    `create_all()` creates missing TABLES but never ALTERs an existing one, so a
    populated schema silently misses every column added after it was first
    created. There is no Alembic in this project, so these additive statements
    are the migration. All are `IF NOT EXISTS` / `IF EXISTS` guarded and safe to
    re-run on every boot.
    """
    statements = [
        # ── Indexes ──
        "CREATE INDEX IF NOT EXISTS ix_rk_aset_waktu "
        "ON riwayat_kondisi (id_aset, waktu_lapor, id_riwayat)",
        "CREATE INDEX IF NOT EXISTS ix_rk_waktu ON riwayat_kondisi (waktu_lapor)",
        "CREATE INDEX IF NOT EXISTS ix_rk_lokasi ON riwayat_kondisi (id_lokasi)",
        "CREATE INDEX IF NOT EXISTS ix_aset_lokasi_status "
        "ON aset (id_lokasi, status_terakhir)",
        "CREATE INDEX IF NOT EXISTS ix_stok_part_lokasi "
        "ON sparepart_stok (id_part, id_lokasi)",
        # ── Presence ──
        "ALTER TABLE pengguna ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP",
        "ALTER TABLE pengguna ADD COLUMN IF NOT EXISTS last_view VARCHAR(50)",
        # ── Spesifikasi teknis (varian) ──
        "ALTER TABLE aset ADD COLUMN IF NOT EXISTS id_varian INTEGER "
        "REFERENCES alat_varian(id_varian)",
        "CREATE INDEX IF NOT EXISTS ix_aset_varian ON aset (id_varian)",
        # Serial number is per physical unit, so it hangs off `aset`, not the
        # shared variant row.
        "ALTER TABLE aset ADD COLUMN IF NOT EXISTS nomor_seri VARCHAR(100)",
        # Spec fields rendered on the public asset card. Adding a column here
        # WITHOUT the matching models.py change (or vice versa) is the failure
        # mode this list exists to prevent — keep the two in step.
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS merk VARCHAR(100)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS tipe_model VARCHAR(100)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS kapasitas VARCHAR(100)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS daya VARCHAR(100)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS dimensi VARCHAR(100)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS berat VARCHAR(50)",
        # ── Katalog SFM flags on the tool type ──
        # `perlu_kalibrasi` gates the Kalibrasi tab; it replaced a hardcoded
        # four-code set in seed.py.
        "ALTER TABLE kategori_alat ADD COLUMN IF NOT EXISTS alat_ukur BOOLEAN "
        "NOT NULL DEFAULT FALSE",
        "ALTER TABLE kategori_alat ADD COLUMN IF NOT EXISTS perlu_kalibrasi BOOLEAN "
        "NOT NULL DEFAULT FALSE",
        "ALTER TABLE kategori_alat ADD COLUMN IF NOT EXISTS kelompok VARCHAR(20)",
        # ── Tool-type documents (the spektek / manual fallback) ──
        # The client's PDFs are filed against alat kerja, not against models:
        # one covers four tools, and several cover tools with no alat_varian
        # row at all. `_varian_payload()` falls back to these.
        "ALTER TABLE kategori_alat ADD COLUMN IF NOT EXISTS url_spek VARCHAR(500)",
        "ALTER TABLE kategori_alat ADD COLUMN IF NOT EXISTS file_spek VARCHAR(255)",
        "ALTER TABLE kategori_alat ADD COLUMN IF NOT EXISTS url_manual VARCHAR(500)",
        "ALTER TABLE kategori_alat ADD COLUMN IF NOT EXISTS file_manual VARCHAR(255)",
        # ── Model/Type spec block, shaped by Rekap Spek RAMCES.docx ──
        # Five free-form label/value pairs, because the row labels differ per
        # tool ("Max. Torque" vs "Runtime" vs "Cutting Wheel") and the fixed
        # kapasitas/daya/dimensi/berat quartet above could not express them.
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS spek1_label VARCHAR(60)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS spek1_nilai VARCHAR(200)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS spek2_label VARCHAR(60)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS spek2_nilai VARCHAR(200)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS spek3_label VARCHAR(60)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS spek3_nilai VARCHAR(200)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS spek4_label VARCHAR(60)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS spek4_nilai VARCHAR(200)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS spek5_label VARCHAR(60)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS spek5_nilai VARCHAR(200)",
        # Photo + the two reference documents. Each is a link OR an upload.
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS foto_url VARCHAR(500)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS foto_file VARCHAR(255)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS url_spek VARCHAR(500)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS file_spek VARCHAR(255)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS url_manual VARCHAR(500)",
        "ALTER TABLE alat_varian ADD COLUMN IF NOT EXISTS file_manual VARCHAR(255)",
        # Fold the four retired fixed columns into the generic slots, so a
        # database populated before this change keeps rendering its specs.
        # Guarded on spek1_label so it is a no-op on every boot after the first
        # (and on a freshly seeded database, where the seed writes the slots
        # directly and there is nothing to migrate).
        """
        UPDATE alat_varian SET
            spek1_label = COALESCE(spek1_label, CASE WHEN kapasitas IS NOT NULL THEN 'Kapasitas' END),
            spek1_nilai = COALESCE(spek1_nilai, kapasitas),
            spek2_label = COALESCE(spek2_label, CASE WHEN daya      IS NOT NULL THEN 'Daya'      END),
            spek2_nilai = COALESCE(spek2_nilai, daya),
            spek3_label = COALESCE(spek3_label, CASE WHEN dimensi   IS NOT NULL THEN 'Dimensi'   END),
            spek3_nilai = COALESCE(spek3_nilai, dimensi),
            spek4_label = COALESCE(spek4_label, CASE WHEN berat     IS NOT NULL THEN 'Berat'     END),
            spek4_nilai = COALESCE(spek4_nilai, berat)
        WHERE spek1_label IS NULL AND spek2_label IS NULL
          AND spek3_label IS NULL AND spek4_label IS NULL
          AND (kapasitas IS NOT NULL OR daya IS NOT NULL
               OR dimensi IS NOT NULL OR berat IS NOT NULL)
        """,
        # ── Sparepart → Model/Type, and the repair-consumption join ──
        "ALTER TABLE sparepart ADD COLUMN IF NOT EXISTS id_varian INTEGER "
        "REFERENCES alat_varian(id_varian)",
        "CREATE INDEX IF NOT EXISTS ix_sparepart_varian ON sparepart (id_varian)",
        # ── Narrowing `sparepart` to what a screen actually reads ──
        #
        # The Tambah Suku Cadang form lost its "Identifikasi" and "Informasi
        # Tambahan" blocks along with Kode SKU and Nomor Part, so these ten
        # columns have no writer and no reader left. Criticality is now derived
        # from `stok <= stok_min` instead of stored (see models.SparePart).
        #
        # GUARDED, like the two statements further down, rather than written as
        # ten bare `DROP COLUMN IF EXISTS`. Every one of those takes an ACCESS
        # EXCLUSIVE lock on `sparepart` even when the column is already gone,
        # and _ensure_schema() runs at IMPORT — so unguarded this would lock the
        # catalogue ten times on every restart, once per uvicorn worker, forever
        # after the migration had nothing left to do. Dropping `sku` takes its
        # unique index with it.
        """
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'sparepart'
              AND column_name IN ('sku', 'part_number', 'serial_numbers',
                                  'lookup_tags', 'is_critical', 'linked_vehicle',
                                  'warranty_months', 'supplier', 'ref_part',
                                  'deskripsi')
          ) THEN
            ALTER TABLE sparepart
              DROP COLUMN IF EXISTS sku,
              DROP COLUMN IF EXISTS part_number,
              DROP COLUMN IF EXISTS serial_numbers,
              DROP COLUMN IF EXISTS lookup_tags,
              DROP COLUMN IF EXISTS is_critical,
              DROP COLUMN IF EXISTS linked_vehicle,
              DROP COLUMN IF EXISTS warranty_months,
              DROP COLUMN IF EXISTS supplier,
              DROP COLUMN IF EXISTS ref_part,
              DROP COLUMN IF EXISTS deskripsi;
          END IF;
        END $$;
        """,
        "CREATE INDEX IF NOT EXISTS ix_pakai_riwayat "
        "ON pemakaian_sparepart (id_riwayat)",
        "CREATE INDEX IF NOT EXISTS ix_pakai_aset ON pemakaian_sparepart (id_aset)",
        "CREATE INDEX IF NOT EXISTS ix_pakai_part ON pemakaian_sparepart (id_part)",
        "CREATE INDEX IF NOT EXISTS ix_pakai_waktu ON pemakaian_sparepart (waktu)",
        # ── Calibration certificate ──
        "ALTER TABLE riwayat_kalibrasi ADD COLUMN IF NOT EXISTS "
        "file_sertifikat VARCHAR(255)",
        # ── Warehouse ── (column first; the index below depends on it)
        "ALTER TABLE sparepart_stok ADD COLUMN IF NOT EXISTS id_gudang INTEGER "
        "REFERENCES gudang(id_gudang)",
        "CREATE INDEX IF NOT EXISTS ix_stok_part_gudang "
        "ON sparepart_stok (id_part, id_gudang)",
        # tipe_gerakan widened from 10 to 20 chars for RETUR_VENDOR / ADJ_OUT.
        #
        # GUARDED, unlike the rest of this list, because `ALTER COLUMN … TYPE`
        # is NOT a no-op when the type already matches: PostgreSQL takes an
        # ACCESS EXCLUSIVE lock and rewrites the whole table plus every index on
        # it. This runs at import, so it happened on every restart and once per
        # uvicorn worker — seconds of total lockout on a 100k-row ledger,
        # minutes at 1M.
        """
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'sparepart_stok'
              AND column_name = 'tipe_gerakan'
              AND character_maximum_length < 20
          ) THEN
            ALTER TABLE sparepart_stok ALTER COLUMN tipe_gerakan TYPE VARCHAR(20);
          END IF;
        END $$
        """,
        # The old CHECK only permitted IN|OUT — replace it with the wider set.
        # Also guarded: ADD CONSTRAINT … CHECK validates every existing row
        # under an ACCESS EXCLUSIVE lock, so re-running it each boot re-scanned
        # the entire ledger for nothing.
        """
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'sparepart_stok_gerakan_check'
          ) THEN
            ALTER TABLE sparepart_stok ADD CONSTRAINT sparepart_stok_gerakan_check
              CHECK (tipe_gerakan IN
                ('IN','OUT','RETUR_VENDOR','RETUR_CUST','ADJ_IN','ADJ_OUT'));
          END IF;
        END $$
        """,

        # ══════════════════════════════════════════════════════════════
        # Foreign-key delete behaviour
        # ══════════════════════════════════════════════════════════════
        #
        # Every FK here was created with the default NO ACTION, which means the
        # database REFUSES the delete and SQLAlchemy surfaces an IntegrityError
        # as an HTTP 500. Concretely: deleting a user who had ever filed a
        # condition report 500'd, and so did deleting an asset with any history —
        # both ordinary administrative actions, both presenting as a server bug.
        #
        #   id_pengguna → SET NULL   the record of WHAT happened must survive the
        #                            departure of the person who recorded it
        #   id_aset     → CASCADE    an asset's history has no meaning without
        #                            the asset, so it goes with it
        #
        # Guarded on `confdeltype` so the DROP/ADD pair runs once and not on
        # every boot: ADD CONSTRAINT re-validates every row under an ACCESS
        # EXCLUSIVE lock, exactly like the CHECK constraint above.
        #
        # Constraint names are looked up rather than hardcoded — PostgreSQL's
        # auto-generated `<table>_<column>_fkey` is the usual name, but a
        # database restored from an older dump may carry another.
        """
        DO $$
        DECLARE
          spec  RECORD;
          fkname TEXT;
        BEGIN
          FOR spec IN
            SELECT * FROM (VALUES
              ('riwayat_kondisi',     'id_pengguna', 'pengguna', 'id_pengguna', 'SET NULL', 'n'),
              ('riwayat_mutasi',      'id_pengguna', 'pengguna', 'id_pengguna', 'SET NULL', 'n'),
              ('riwayat_kalibrasi',   'id_pengguna', 'pengguna', 'id_pengguna', 'SET NULL', 'n'),
              ('sparepart_stok',      'id_pengguna', 'pengguna', 'id_pengguna', 'SET NULL', 'n'),
              ('riwayat_kondisi',     'id_aset',     'aset',     'id_aset',     'CASCADE',  'c'),
              ('riwayat_mutasi',      'id_aset',     'aset',     'id_aset',     'CASCADE',  'c'),
              ('pemakaian_sparepart', 'id_aset',     'aset',     'id_aset',     'CASCADE',  'c'),
              -- The pass above reached pemakaian_sparepart through id_aset and
              -- stopped there, but delete_aset() removes the asset's
              -- riwayat_kondisi rows DIRECTLY -- so a repair that consumed
              -- spare parts left this FK pointing at a row being deleted and
              -- PostgreSQL rejected the whole delete with a 500. Deleting an
              -- asset is an ordinary administrative action; it must not depend
              -- on whether anyone ever booked parts against it.
              ('pemakaian_sparepart', 'id_riwayat',  'riwayat_kondisi', 'id_riwayat', 'CASCADE', 'c')
            ) AS t(tbl, col, ref_tbl, ref_col, action, want)
          LOOP
            SELECT c.conname INTO fkname
            FROM pg_constraint c
            JOIN pg_class      r ON r.oid = c.conrelid
            JOIN pg_attribute  a ON a.attrelid = c.conrelid
                                AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f'
              AND r.relname = spec.tbl
              AND a.attname = spec.col
              AND array_length(c.conkey, 1) = 1
              AND c.confdeltype <> spec.want
            LIMIT 1;

            IF fkname IS NOT NULL THEN
              -- SET NULL needs a nullable column; riwayat_kalibrasi.id_pengguna
              -- was declared NOT NULL and would reject the cascade at runtime.
              IF spec.action = 'SET NULL' THEN
                EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL',
                               spec.tbl, spec.col);
              END IF;
              EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', spec.tbl, fkname);
              EXECUTE format(
                'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) '
                'REFERENCES %I(%I) ON DELETE %s',
                spec.tbl, fkname, spec.col, spec.ref_tbl, spec.ref_col, spec.action);
            END IF;
            fkname := NULL;
          END LOOP;
        END $$
        """,

        # ── Indexes added after the performance audit ──
        #
        # riwayat_mutasi had NO index at all beyond its primary key, and is
        # queried per-asset inside the export loops — so every one of those
        # lookups was a sequential scan of the whole table. The composite also
        # serves the `ORDER BY waktu_mutasi` those queries all carry.
        "CREATE INDEX IF NOT EXISTS ix_rm_aset_waktu "
        "ON riwayat_mutasi (id_aset, waktu_mutasi)",
        "CREATE INDEX IF NOT EXISTS ix_rm_lokasi_asal "
        "ON riwayat_mutasi (id_lokasi_asal)",
        "CREATE INDEX IF NOT EXISTS ix_rm_lokasi_tujuan "
        "ON riwayat_mutasi (id_lokasi_tujuan)",
        # Partial: the repair dashboards filter kondisi='TSO' constantly, and
        # ix_rk_aset_waktu leads with id_aset so it cannot serve that predicate.
        "CREATE INDEX IF NOT EXISTS ix_rk_tso ON riwayat_kondisi "
        "(id_aset, waktu_lapor) WHERE kondisi = 'TSO'",
        "CREATE INDEX IF NOT EXISTS ix_rk_kondisi_aset "
        "ON riwayat_kondisi (kondisi, id_aset)",
        # Turns _last_out_map's full ledger scan into an index-only scan.
        "CREATE INDEX IF NOT EXISTS ix_stok_gerakan_part_waktu "
        "ON sparepart_stok (tipe_gerakan, id_part, waktu DESC)",
        "CREATE INDEX IF NOT EXISTS ix_stok_ref_transfer "
        "ON sparepart_stok (id_ref_transfer) WHERE id_ref_transfer IS NOT NULL",
        # create_aset counts assets of the same kode_alat on every insert.
        "CREATE INDEX IF NOT EXISTS ix_aset_kode_alat ON aset (kode_alat)",
        "CREATE INDEX IF NOT EXISTS ix_kal_aset_tanggal "
        "ON riwayat_kalibrasi (id_aset, tanggal_kalibrasi, waktu_input)",
        # Unindexed FKs, each of which forces a scan of the child table whenever
        # the parent row is deleted.
        "CREATE INDEX IF NOT EXISTS ix_rk_pengguna ON riwayat_kondisi (id_pengguna)",
        "CREATE INDEX IF NOT EXISTS ix_rm_pengguna ON riwayat_mutasi (id_pengguna)",
        "CREATE INDEX IF NOT EXISTS ix_stok_pengguna ON sparepart_stok (id_pengguna)",
        "CREATE INDEX IF NOT EXISTS ix_pengguna_lokasi ON pengguna (id_lokasi)",
        "CREATE INDEX IF NOT EXISTS ix_sparepart_kategori ON sparepart (id_kategori)",
        "CREATE INDEX IF NOT EXISTS ix_sparepart_kode_alat ON sparepart (kode_alat)",

        # ── Self-registration and approval (pengguna) ──
        #
        # `created_at` gets NO default on purpose: `DEFAULT NOW()` would stamp
        # every row that existed before this migration with the migration's own
        # timestamp, which then reads as the account's creation date forever.
        # NULL is the honest value for "we did not record it".
        "ALTER TABLE pengguna ADD COLUMN IF NOT EXISTS status VARCHAR(16) "
        "NOT NULL DEFAULT 'AKTIF'",
        "ALTER TABLE pengguna ADD COLUMN IF NOT EXISTS nama_lengkap VARCHAR(120)",
        "ALTER TABLE pengguna ADD COLUMN IF NOT EXISTS created_at TIMESTAMP",
        "ALTER TABLE pengguna ADD COLUMN IF NOT EXISTS approved_by INTEGER",
        "ALTER TABLE pengguna ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP",
        "UPDATE pengguna SET status = UPPER(status) "
        "WHERE status IS NOT NULL AND status <> UPPER(status)",
        # Guarded for the same reason as every other ADD CONSTRAINT here: it is
        # not IF NOT EXISTS-able, it takes an ACCESS EXCLUSIVE lock while it
        # rescans, and _ensure_schema() runs at import — so unguarded it locks
        # `pengguna` on every restart, once per worker.
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'ck_pengguna_status'
            ) THEN
                ALTER TABLE pengguna
                    ADD CONSTRAINT ck_pengguna_status
                    CHECK (status IN ('AKTIF', 'PENDING', 'DITOLAK', 'NONAKTIF'));
            END IF;
        END $$;
        """,
        # The approvals queue filters on this and nothing else.
        "CREATE INDEX IF NOT EXISTS ix_pengguna_status ON pengguna (status)",

        # ── dokumen_alat ──
        #
        # The TABLE itself is created by `Base.metadata.create_all()` from its
        # declaration in models.py, not here — a raw-DDL-only table survives
        # `manage.py reset`'s drop_all and then collides with the recreate. What
        # belongs here is what create_all cannot express: the CHECK, and the
        # partial unique index that makes "exactly one primary document per
        # (tool, kind)" a database fact rather than a seeder convention.
        #
        # Both are existence-guarded. `ADD CONSTRAINT` is not `IF NOT EXISTS`-
        # able in PostgreSQL and takes an ACCESS EXCLUSIVE lock while it
        # rescans, and _ensure_schema() runs at IMPORT — so unguarded this would
        # lock the table on every restart, per worker.
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'ck_dokumen_alat_jenis'
            ) AND EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_name = 'dokumen_alat'
            ) THEN
                ALTER TABLE dokumen_alat
                    ADD CONSTRAINT ck_dokumen_alat_jenis
                    CHECK (jenis IN ('SPEK', 'MANUAL'));
            END IF;
        END $$;
        """,
        # One document may be named by several tools (one file covers four), so
        # the uniqueness is per (kode_alat, jenis, nama_file), not per file.
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_dokumen_alat_row "
        "ON dokumen_alat (kode_alat, jenis, nama_file)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_dokumen_alat_utama "
        "ON dokumen_alat (kode_alat, jenis) WHERE utama",

        # ── Stock opname (rev0.4.6) ──
        #
        # The tables themselves are declared in models.py and created by
        # `create_all`; these are the two things it cannot express.
        #
        # ONE OPEN COUNT PER WAREHOUSE, as a database fact rather than a
        # check-then-insert in the endpoint. Two counters opening a session for
        # the same gudang at the same moment would each snapshot the same
        # balances and then each post an adjustment against them — double
        # counting every variance. A partial unique index makes the second
        # INSERT fail instead.
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_opname_draft_per_gudang "
        "ON opname_sesi (id_gudang) WHERE status = 'DRAFT'",
        # Posting reads every line of a session at once.
        "CREATE INDEX IF NOT EXISTS ix_opname_baris_sesi "
        "ON opname_baris (id_opname, id_part)",

        # ── Normalise status_terakhir ──
        #
        # Five queries wrapped this column in func.upper(), which makes both
        # declared indexes on it unusable, while six others compared it raw —
        # so half the code was wrong whichever way the data actually looked.
        # Normalising once here lets every comparison be a plain indexed
        # equality. Idempotent: the WHERE means a clean database updates zero
        # rows and the statement costs one index scan.
        "UPDATE aset SET status_terakhir = UPPER(status_terakhir) "
        "WHERE status_terakhir IS NOT NULL AND status_terakhir <> UPPER(status_terakhir)",
        "UPDATE riwayat_kondisi SET kondisi = UPPER(kondisi) "
        "WHERE kondisi IS NOT NULL AND kondisi <> UPPER(kondisi)",
    ]
    for stmt in statements:
        # Each in its own transaction: one failure (e.g. a constraint that
        # already exists in a different form) must not roll back the rest.
        try:
            with engine.begin() as conn:
                conn.execute(sa_text(stmt))
        except Exception as exc:  # never block startup on schema touch-up
            print(f"[warn] schema step skipped: {stmt[:60]}… → {exc}")

