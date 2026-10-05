-- WARP-3506: Camera.name becomes the Frigate key.
--
-- A camera had two identities. The operator typed a name and it was stored
-- verbatim as Camera.name; addCamera() then lower-cased it and replaced every
-- character outside [a-z0-9_] to get the key Frigate files the camera under.
-- Every DB<->Frigate join (the reconcile prune, getCameras, the per-camera
-- routes) assumed the two were equal. They were not: `Warp_Lab_Office` went into
-- Frigate as `warp_lab_office`, no Camera row carried that name, and the
-- reconcile pruned it as an orphan. There is now one identity: Camera.name IS
-- the Frigate key, always the output of toFrigateKey()
-- (src/services/camera-key.ts), and what the operator typed lives in
-- displayName. This migration rewrites the rows that predate that rule.
--
-- The key, in SQL. Step for step toFrigateKey(): lower-case, every character
-- outside [a-z0-9_] to `_`, then strip leading and trailing `_`. Two details
-- that JS does implicitly are spelled out so both sides give the same string:
--   * JS regexes (no `u` flag) count UTF-16 code units, so a character outside
--     the BMP (an emoji) is two units and becomes `__`; regexp_replace counts
--     code points and would give one `_`. The inner regexp_replace expands
--     each such character to `__` first.
--   * JS lower-cases U+0130 (dotted capital I) to `i` plus a combining dot
--     (which then becomes `_`) and U+212A (Kelvin sign) to `k`, while Postgres
--     lower() answers according to the database locale. Both are replaced
--     explicitly before lower().
-- chr() and the \U escape need a UTF8 database, which the pgvector image creates.
--
-- Collisions. Camera.name is UNIQUE, so two rows can map to one key (`Hall-Way`
-- and `HALL_WAY`, or `Cam-One` next to an existing `cam_one`). Rows are taken
-- ADOPTED first, then oldest first (createdAt, then id) -- an adopted camera
-- outranks age here as it does in a discovery merge; the first to claim a key
-- keeps it, and a row whose key is already another row's name is LEFT AS IT IS
-- with a WARNING naming both rows. So is a name with no usable key (`---`, `___`,
-- `日本`). A collision never raises and nothing is deleted or merged: which of
-- two cameras is the real one is not something a migration can know. (WARNING,
-- not NOTICE: Postgres' default log_min_messages keeps NOTICEs out of the
-- server log, and `prisma migrate deploy` does not relay either, so a NOTICE
-- would leave no trace of the rows left behind.)
--
-- Other tables. Everything that points at a camera does it by Camera.id
-- (CameraGroupMember, CameraAccessGrant, CameraNotificationPref), which a rename
-- does not change. The one exception is CameraPin: it stores the camera NAME in
-- a plain string column (no foreign key, unique per userId + cameraName), so a
-- renamed camera's pins move with it. A pin whose user already pins the new name
-- is skipped, because the unique index would reject it, and stays where it is.
-- displayName is not touched.
--
-- Idempotent: after a run every row either is its own key or was reported
-- above, so a second run renames nothing (the rows left behind just WARN
-- again). One DO block, so the file is a single statement.

DO $$
DECLARE
    r        record;
    owner_id text;
    renamed  integer := 0;
    skipped  integer := 0;
BEGIN
    FOR r IN
        SELECT k."id", k."name", k."canon"
        FROM (
            SELECT "id", "name", "createdAt", "adoption",
                   trim(both '_' from
                        regexp_replace(
                            regexp_replace(
                                lower(replace(replace("name", chr(304), 'i_'), chr(8490), 'k')),
                                '[\U00010000-\U0010FFFF]', '__', 'g'),
                            '[^a-z0-9_]', '_', 'g')) AS "canon"
            FROM "Camera"
        ) k
        WHERE k."name" <> k."canon"
        ORDER BY (k."adoption" = 'ADOPTED') DESC, k."createdAt" ASC, k."id" ASC
    LOOP
        IF r.canon = '' THEN
            RAISE WARNING 'WARP-3506: camera % (name %): no usable Frigate key, left unchanged',
                r.id, r.name;
            skipped := skipped + 1;
            CONTINUE;
        END IF;

        -- Includes a row renamed earlier in this loop: the SELECT sees it.
        SELECT o."id" INTO owner_id
        FROM "Camera" o
        WHERE o."name" = r.canon AND o."id" <> r.id
        LIMIT 1;
        IF FOUND THEN
            RAISE WARNING 'WARP-3506: camera % (name %): Frigate key % is already the name of camera %, left unchanged',
                r.id, r.name, r.canon, owner_id;
            skipped := skipped + 1;
            CONTINUE;
        END IF;

        BEGIN
            UPDATE "Camera" SET "name" = r.canon WHERE "id" = r.id;

            UPDATE "CameraPin" p
            SET "cameraName" = r.canon
            WHERE p."cameraName" = r.name
              AND NOT EXISTS (
                  SELECT 1
                  FROM "CameraPin" q
                  WHERE q."userId" = p."userId" AND q."cameraName" = r.canon
              );

            renamed := renamed + 1;
        EXCEPTION
            WHEN unique_violation THEN
                -- A concurrent writer claimed the key between the check above
                -- and the UPDATE. Both UPDATEs roll back together; never abort.
                RAISE WARNING 'WARP-3506: camera % (name %): Frigate key % was claimed concurrently, left unchanged',
                    r.id, r.name, r.canon;
                skipped := skipped + 1;
        END;
    END LOOP;

    IF renamed + skipped > 0 THEN
        RAISE NOTICE 'WARP-3506: % camera(s) renamed to their Frigate key, % left unchanged',
            renamed, skipped;
    END IF;
END $$;
