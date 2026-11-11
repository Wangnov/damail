/**
 * 直接在数据库中创建 / 重置管理员（绕过网页的 8 位密码限制，仅建议本地开发使用）。
 * 用法：pnpm --filter server exec tsx --env-file=../.env scripts/create-admin.ts <用户名> <密码>
 */
import { db, pool } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/crypto.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('用法: create-admin.ts <用户名> <密码>');
  process.exit(1);
}
const passwordHash = await hashPassword(password);
await db.insert(users).values({ username, passwordHash }).onConflictDoUpdate({ target: users.username, set: { passwordHash } });
console.log(`管理员 ${username} 已创建 / 重置`);
await pool.end();
