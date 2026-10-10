-- WARP-3962 (Romain, 2026-10-10): tool permissions per MCP server, bound to the
-- product contract: "reads run automatically, writes ask for a thumbs-up,
-- destructive actions are blocked."
--
-- `grade` is what a tool DOES (read | write | destructive), recorded on the
-- classification row so the permission a person may choose can be validated
-- against it: read -> always|ask|block, write -> ask|block, destructive -> block.
-- Never derived from the other columns. An unknown grade is WRITE (fail closed).

CREATE TYPE "RemoteToolGrade" AS ENUM ('READ', 'WRITE', 'DESTRUCTIVE');

ALTER TABLE "RemoteToolClassification"
  ADD COLUMN "grade" "RemoteToolGrade" NOT NULL DEFAULT 'WRITE';

-- The reviewed Atlassian table (atlassian-tool-policy.ts) is the source of the
-- grades: its 26 reads, its one destructive tool, everything else stays WRITE.
UPDATE "RemoteToolClassification"
SET "grade" = 'READ'
WHERE "serverId" = 'atlassian'
  AND "toolName" IN (
    'atlassianUserInfo', 'fetch', 'getAccessibleAtlassianResources',
    'getCompassComponent', 'getCompassComponents', 'getCompassCustomFieldDefinitions',
    'getConfluenceCommentChildren', 'getConfluencePage', 'getConfluencePageDescendants',
    'getConfluencePageFooterComments', 'getConfluencePageInlineComments', 'getConfluenceSpaces',
    'getIssueLinkTypes', 'getJiraIssue', 'getJiraIssueRemoteIssueLinks',
    'getJiraIssueTypeMetaWithFields', 'getJiraProjectIssueTypesMetadata',
    'getPagesInConfluenceSpace', 'getTeamworkGraphContext', 'getTeamworkGraphObject',
    'getTransitionsForJiraIssue', 'getVisibleJiraProjects', 'lookupJiraAccountId',
    'search', 'searchConfluenceUsingCql', 'searchJiraIssuesUsingJql'
  );

UPDATE "RemoteToolClassification"
SET "grade" = 'DESTRUCTIVE'
WHERE "serverId" = 'atlassian' AND "toolName" = 'updateConfluencePage';

-- The default permission per grade, applied ONLY where no human has reviewed the
-- row ("reviewedAt" IS NULL): a person's decision is kept. Extensions (ext-*)
-- have their own review lifecycle and are not touched; a row whose definition
-- CHANGED (WARP-3918) stays switched off until a person classifies it again.
-- A block ("denied") is never lifted here.
UPDATE "RemoteToolClassification"
SET "requiresWrite" = false, "requiresConfirmation" = false, "allowlisted" = true
WHERE "grade" = 'READ' AND "reviewedAt" IS NULL AND "denied" = false
  AND "definitionStatus" = 'CURRENT' AND "serverId" NOT LIKE 'ext-%';

UPDATE "RemoteToolClassification"
SET "requiresWrite" = true, "requiresConfirmation" = true, "allowlisted" = true
WHERE "grade" = 'WRITE' AND "reviewedAt" IS NULL AND "denied" = false
  AND "definitionStatus" = 'CURRENT' AND "serverId" NOT LIKE 'ext-%';

UPDATE "RemoteToolClassification"
SET "requiresWrite" = true, "requiresConfirmation" = true, "denied" = true, "allowlisted" = false
WHERE "grade" = 'DESTRUCTIVE' AND "reviewedAt" IS NULL AND "serverId" NOT LIKE 'ext-%';
