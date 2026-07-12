-- WARP-263: per-device hardware inventory baseline, signed with the WARP-230
-- device-identity key. Singleton row (id = 'singleton'), same pattern as
-- "ApplianceSetup". Populated lazily by hardware-bom.service.ts on first
-- boot check -- no seed row here.
CREATE TABLE "HardwareBaseline" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "components" JSONB NOT NULL,
    "componentsHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HardwareBaseline_pkey" PRIMARY KEY ("id")
);
