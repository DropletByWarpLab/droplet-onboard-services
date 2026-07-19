-- WARP-1341: business-only build — BUSINESS becomes the Workspace.type
-- default, and any existing HOME row (fresh setups never set the type,
-- so they were all HOME) is flipped. The HOME enum value is kept so the
-- migration is non-destructive to the type itself.
ALTER TABLE "Workspace" ALTER COLUMN "type" SET DEFAULT 'BUSINESS';
UPDATE "Workspace" SET "type" = 'BUSINESS' WHERE "type" = 'HOME';

-- The "Home" module preset is withdrawn from the registry. A row that had
-- applied it keeps its module toggles verbatim by moving to 'custom'
-- (= "leave current toggles as-is"), so nothing turns off under the user.
UPDATE "Workspace" SET "businessType" = 'custom' WHERE "businessType" = 'home';
