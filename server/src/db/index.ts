import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export const db = drizzle(pool, { schema, casing: 'snake_case' });

export async function runMigrations() {
  // 开发时位于 src/db/../../drizzle，打包后位于 dist/drizzle
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'drizzle'), path.join(here, '../../drizzle')];
  const migrationsFolder = candidates.find((p) => existsSync(p));
  if (!migrationsFolder) throw new Error('找不到 drizzle 迁移目录');
  await migrate(db, { migrationsFolder });
}
