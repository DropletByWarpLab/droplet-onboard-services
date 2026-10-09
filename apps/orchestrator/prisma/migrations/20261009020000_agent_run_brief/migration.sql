ALTER TABLE "AgentRun" ADD COLUMN "brief" TEXT;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_brief_supported_check"
  CHECK ("brief" IS NULL OR "brief" = 'app-setup');
