import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { errors, type Adapter, type AdapterPayload } from 'oidc-provider';
import { db } from '../db/index.js';
import { mcpAuthorizations, oauthPayloads } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';

/**
 * oidc-provider 的 PostgreSQL 存储。
 *
 * - 主键只存 id 的 SHA-256 摘要；授权码、access / refresh token 只需要比较，不需要还原
 * - payload 里去掉 jti（就是令牌值本身），读取时用调用方传入的 id 补回
 * - consume 是原子操作：并发兑换同一个授权码 / refresh token 时只有一个成功，
 *   其余视为重放，撤销整个授权（与 oidc-provider 对已消费令牌的处理一致）
 * - revokeByGrantId 同时把 mcp_authorizations 标记为已撤销，资源服务器每次请求都会检查
 */

// 这些模型的 id 就是发给客户端的凭证；Session / Interaction / Grant 的 id 另有 Cookie 或登录校验保护
const SECRET_MODELS = new Set(['AuthorizationCode', 'AccessToken', 'RefreshToken']);

function strip(model: string, payload: AdapterPayload) {
  if (!SECRET_MODELS.has(model)) return { ...payload } as Record<string, unknown>;
  const { jti: _jti, ...rest } = payload;
  return rest as Record<string, unknown>;
}

export async function revokeGrant(grantId: string, reason: string) {
  await db.transaction(async (tx) => {
    await tx
      .update(mcpAuthorizations)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where(and(eq(mcpAuthorizations.grantId, grantId), isNull(mcpAuthorizations.revokedAt)));
    await tx.delete(oauthPayloads).where(eq(oauthPayloads.grantId, grantId));
  });
}

export class PgAdapter implements Adapter {
  constructor(private readonly model: string) {}

  private key(id: string) {
    return and(eq(oauthPayloads.model, this.model), eq(oauthPayloads.idHash, sha256(id)));
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    const values = {
      model: this.model,
      idHash: sha256(id),
      payload: strip(this.model, payload),
      // Grant 自己的记录也挂到 grant_id 上，撤销时一并删除，refresh 再也找不到 Grant
      grantId: this.model === 'Grant' ? id : (payload.grantId ?? null),
      uid: payload.uid ?? null,
      expiresAt,
    };
    await db
      .insert(oauthPayloads)
      .values(values)
      .onConflictDoUpdate({
        target: [oauthPayloads.model, oauthPayloads.idHash],
        set: { payload: values.payload, grantId: values.grantId, uid: values.uid, expiresAt },
      });
  }

  private async load(where: ReturnType<PgAdapter['key']>, id?: string) {
    const row = await db.query.oauthPayloads.findFirst({ where });
    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;
    const payload = { ...row.payload } as AdapterPayload;
    if (id !== undefined && SECRET_MODELS.has(this.model)) payload.jti = id;
    if (row.consumedAt) payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
    return payload;
  }

  async find(id: string) {
    return this.load(this.key(id), id);
  }

  async findByUid(uid: string) {
    return this.load(and(eq(oauthPayloads.model, this.model), eq(oauthPayloads.uid, uid))!);
  }

  async findByUserCode() {
    // 未启用设备码流程
    return undefined;
  }

  async consume(id: string) {
    const rows = await db
      .update(oauthPayloads)
      .set({ consumedAt: new Date() })
      .where(and(this.key(id), isNull(oauthPayloads.consumedAt)))
      .returning({ grantId: oauthPayloads.grantId });
    if (rows.length) return;
    // 已被另一个并发请求消费：按重放处理，撤销整个授权
    const row = await db.query.oauthPayloads.findFirst({ where: this.key(id), columns: { grantId: true } });
    if (row?.grantId) {
      await revokeGrant(row.grantId, 'replay');
      audit('system', 'mcp_oauth.replay', { detail: { model: this.model, grantId: row.grantId } });
    }
    throw new errors.InvalidGrant(`${this.model === 'RefreshToken' ? 'refresh token' : 'grant'} already consumed`);
  }

  async destroy(id: string) {
    await db.delete(oauthPayloads).where(this.key(id));
  }

  async revokeByGrantId(grantId: string) {
    await revokeGrant(grantId, 'grant');
  }
}

/** 定期清理过期记录（过期的令牌本来就不会被接受，这里只是回收空间） */
export async function purgeExpiredOAuthPayloads() {
  await db.delete(oauthPayloads).where(lt(oauthPayloads.expiresAt, sql`now() - interval '1 day'`));
}
