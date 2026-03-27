-- CreateTable
CREATE TABLE "SyncTarget" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "intervalMin" INTEGER NOT NULL DEFAULT 30,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSync" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileEntry" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDirectory" BOOLEAN NOT NULL DEFAULT false,
    "size" BIGINT NOT NULL DEFAULT 0,
    "mimeType" TEXT,
    "hash" TEXT,
    "modifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncTarget_path_key" ON "SyncTarget"("path");

-- CreateIndex
CREATE UNIQUE INDEX "FileEntry_targetId_path_key" ON "FileEntry"("targetId", "path");

-- AddForeignKey
ALTER TABLE "FileEntry" ADD CONSTRAINT "FileEntry_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "SyncTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
