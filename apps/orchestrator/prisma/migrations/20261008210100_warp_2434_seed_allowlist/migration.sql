-- WARP-2434 (Romain, 2026-10-08: keep reviewed tools working on upgrade).
-- Seed `allowlisted = true` for exactly the vendor tools stage's dispatch
-- (composeRemoteCallPolicy over remoteToolTablePolicy) allows today. New and
-- unreviewed tools, denied tools, and extension (`ext-*`) servers stay off.
--
-- 1. Atlassian: the curated table's v1 reads reachable on an API-token
--    connection (grade read, v1 allowed, product not compass) = the 23 names
--    below. Pinned to ATLASSIAN_TOOL_CLASSIFICATIONS by
--    remote-tool-allowlist.seed.test.ts.
-- 2. The record fills only a table HOLE: an owner-reviewed read (reviewedAt set,
--    requiresWrite false) of a tool the table does not list. For Atlassian that
--    means a name outside the table's 40 rows; for any other vendor server there
--    is no table, so every reviewed read.
UPDATE "RemoteToolClassification"
SET "allowlisted" = true
WHERE "denied" = false
  AND "serverId" NOT LIKE 'ext-%'
  AND (
    (
      "serverId" = 'atlassian'
      AND "toolName" IN (
        'atlassianUserInfo', 'fetch', 'getAccessibleAtlassianResources',
        'getConfluenceCommentChildren', 'getConfluencePage', 'getConfluencePageDescendants',
        'getConfluencePageFooterComments', 'getConfluencePageInlineComments', 'getConfluenceSpaces',
        'getIssueLinkTypes', 'getJiraIssue', 'getJiraIssueRemoteIssueLinks',
        'getJiraIssueTypeMetaWithFields', 'getJiraProjectIssueTypesMetadata',
        'getPagesInConfluenceSpace', 'getTeamworkGraphContext', 'getTeamworkGraphObject',
        'getTransitionsForJiraIssue', 'getVisibleJiraProjects', 'lookupJiraAccountId',
        'search', 'searchConfluenceUsingCql', 'searchJiraIssuesUsingJql'
      )
    )
    OR (
      "reviewedAt" IS NOT NULL
      AND "requiresWrite" = false
      AND (
        "serverId" <> 'atlassian'
        OR "toolName" NOT IN (
          'addCommentToJiraIssue', 'addTeamworkGraphContext', 'addWorklogToJiraIssue',
          'atlassianUserInfo', 'createCompassComponent', 'createCompassComponentRelationship',
          'createCompassCustomFieldDefinition', 'createConfluenceFooterComment',
          'createConfluenceInlineComment', 'createConfluencePage', 'createIssueLink',
          'createJiraIssue', 'editJiraIssue', 'fetch', 'getAccessibleAtlassianResources',
          'getCompassComponent', 'getCompassComponents', 'getCompassCustomFieldDefinitions',
          'getConfluenceCommentChildren', 'getConfluencePage', 'getConfluencePageDescendants',
          'getConfluencePageFooterComments', 'getConfluencePageInlineComments',
          'getConfluenceSpaces', 'getIssueLinkTypes', 'getJiraIssue',
          'getJiraIssueRemoteIssueLinks', 'getJiraIssueTypeMetaWithFields',
          'getJiraProjectIssueTypesMetadata', 'getPagesInConfluenceSpace',
          'getTeamworkGraphContext', 'getTeamworkGraphObject', 'getTransitionsForJiraIssue',
          'getVisibleJiraProjects', 'lookupJiraAccountId', 'search', 'searchConfluenceUsingCql',
          'searchJiraIssuesUsingJql', 'transitionJiraIssue', 'updateConfluencePage'
        )
      )
    )
  );
