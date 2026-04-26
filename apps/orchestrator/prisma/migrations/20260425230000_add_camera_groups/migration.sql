-- CreateTable
CREATE TABLE "CameraGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CameraGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraGroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CameraGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CameraGroup_name_key" ON "CameraGroup"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CameraGroupMember_groupId_cameraId_key" ON "CameraGroupMember"("groupId", "cameraId");

-- CreateIndex
CREATE INDEX "CameraGroupMember_groupId_idx" ON "CameraGroupMember"("groupId");

-- CreateIndex
CREATE INDEX "CameraGroupMember_cameraId_idx" ON "CameraGroupMember"("cameraId");

-- AddForeignKey
ALTER TABLE "CameraGroupMember" ADD CONSTRAINT "CameraGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CameraGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CameraGroupMember" ADD CONSTRAINT "CameraGroupMember_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;
