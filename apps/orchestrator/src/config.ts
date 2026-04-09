import * as path from "node:path";
import { z } from "zod";

// In Docker, FILES_ROOT is set to /data/files (volume mount).
// In local dev, default to .data/files relative to cwd (no root permissions needed).
const defaultFilesRoot =
  process.env.NODE_ENV === "production" ? "/data/files" : path.resolve(".data/files");

const defaultMatterStorage =
  process.env.NODE_ENV === "production" ? "/data/matter-storage" : path.resolve(".data/matter-storage");

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://droplet:droplet@localhost:5432/droplet"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  MQTT_BROKER: z.string().default("mqtt://localhost:1883"),
  AI_GATEWAY_URL: z.string().default("http://localhost:8000"),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  FILES_ROOT: z.string().min(1).default(defaultFilesRoot),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(100),

  // --- Phase 1: Nextcloud integration ---
  STORAGE_BACKEND: z.enum(["legacy", "nextcloud"]).default("legacy"),
  NEXTCLOUD_URL: z.string().default("http://localhost:8080"),
  AUTH_ENABLED: z.coerce.boolean().default(false),

  // --- Home Assistant (legacy, kept for optional fallback) ---
  HOMEASSISTANT_URL: z.string().default("http://localhost:8123"),
  HOMEASSISTANT_TOKEN: z.string().default(""),

  // --- Matter (native controller) ---
  MATTER_STORAGE_PATH: z.string().default(defaultMatterStorage),
  MATTER_CONTROLLER_NAME: z.string().default("Droplet"),

  // --- OAuth2 ---
  AUTH_MODE: z.enum(["oauth2", "legacy"]).default("legacy"),
  OAUTH2_CLIENT_ID: z.string().default(""),
  OAUTH2_CLIENT_SECRET: z.string().default(""),

  // --- gRPC ---
  AI_GATEWAY_GRPC_URL: z.string().default("localhost:50051"),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
