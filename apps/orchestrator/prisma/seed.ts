import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.device.upsert({
    where: { deviceId: "droplet-dev-001" },
    update: {},
    create: {
      deviceId: "droplet-dev-001",
      hostname: "droplet-pi",
      hardwareRev: "dev",
      networkMode: "dhcp",
      ip: "192.168.1.100",
    },
  });

  console.log("Seed data created: droplet-dev-001");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
