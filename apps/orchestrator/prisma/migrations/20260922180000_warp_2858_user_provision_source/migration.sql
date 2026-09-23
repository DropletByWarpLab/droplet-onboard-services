-- WARP-2858 — User.provisionSource: where an account was created.
--
-- An explicit enum column (never inferred from a null passwordHash or
-- nextcloudUsername). The box refuses to set, change or verify a local
-- password on an SSO- or SCIM-provisioned account: a local password there is
-- a login the IdP's disable/deprovision cannot reach.
--
-- Predecessor: 20260919230000_warp_2426_remote_tool_classification.

-- CreateEnum
CREATE TYPE "UserProvisionSource" AS ENUM ('LOCAL', 'SSO', 'SCIM');

-- AlterTable — every existing row defaults LOCAL.
ALTER TABLE "User" ADD COLUMN "provisionSource" "UserProvisionSource" NOT NULL DEFAULT 'LOCAL';

-- One-time backfill for rows created BEFORE this column existed. From here on
-- the creating path writes the value; this is the only place it is derived.
--
-- Every LOCAL creation path (/auth/setup, admin create, invite accept) writes
-- nextcloudUsername; the SSO just-in-time create and SCIM provisionUser never
-- do, and both link an SsoIdentity. So "no mapping key AND at least one SSO
-- link" identifies exactly the IdP-created rows (service principals have no
-- SsoIdentity). SCIM links under provider 'okta' (scim.service.ts
-- OKTA_PROVIDER); anything else was an OIDC sign-in. An Okta OIDC JIT row is
-- therefore tagged SCIM — both sources get the same password treatment, so the
-- only effect is the roster label.
UPDATE "User" u
SET "provisionSource" = CASE
    WHEN EXISTS (SELECT 1 FROM "SsoIdentity" s WHERE s."userId" = u."id" AND s."provider" = 'okta')
      THEN 'SCIM'::"UserProvisionSource"
    ELSE 'SSO'::"UserProvisionSource"
  END
WHERE u."nextcloudUsername" IS NULL
  AND EXISTS (SELECT 1 FROM "SsoIdentity" s WHERE s."userId" = u."id");
