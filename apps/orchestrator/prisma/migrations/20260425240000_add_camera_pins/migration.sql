-- CreateTable
CREATE TABLE "CameraPin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cameraName" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CameraPin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CameraPin_userId_cameraName_key" ON "CameraPin"("userId", "cameraName");

-- CreateIndex
CREATE INDEX "CameraPin_userId_idx" ON "CameraPin"("userId");
