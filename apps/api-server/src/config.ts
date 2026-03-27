import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://droplet:droplet@localhost:5432/droplet"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  MQTT_BROKER: z.string().default("mqtt://localhost:1883"),
  AI_GATEWAY_URL: z.string().default("http://localhost:8000"),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
