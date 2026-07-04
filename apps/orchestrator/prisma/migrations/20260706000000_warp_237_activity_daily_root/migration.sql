-- WARP-237: device-key-signed daily roots over the activity chain
CREATE TABLE "ActivityDailyRoot" (
    "id" BIGSERIAL NOT NULL,
    "date" TEXT NOT NULL,
    "firstRowId" BIGINT NOT NULL,
    "lastRowId" BIGINT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "tailSignatureHash" TEXT NOT NULL,
    "prevRootHash" TEXT NOT NULL,
    "rootHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityDailyRoot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActivityDailyRoot_date_key" ON "ActivityDailyRoot"("date");
