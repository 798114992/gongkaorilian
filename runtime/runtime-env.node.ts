import { createLocalD1, createLocalMediaBucket } from "./sqlite-runtime";

const databasePath = process.env.SQLITE_PATH || "./data/gongkaorilian.sqlite";
const mediaPath = process.env.MEDIA_PATH || "./data/media";

export const env = {
  ...process.env,
  DB: createLocalD1(databasePath),
  MEDIA: createLocalMediaBucket(mediaPath),
  RUNTIME_SCHEMA_BOOTSTRAP: process.env.RUNTIME_SCHEMA_BOOTSTRAP || "migrated",
};
