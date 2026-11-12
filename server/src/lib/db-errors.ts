/**
 * 判断入库失败是不是「这封邮件本身的数据有问题」：重试也一定失败，只能跳过。
 * PostgreSQL 错误码 22xxx（数据异常，如非法字符、编码错误）、54xxx（超出限制，如索引行过大、tsvector 太长）。
 * 连接断开、磁盘写满、锁超时等基础设施错误不算，应该中断本次同步、不推进游标，下次重试。
 * drizzle 把驱动的错误包在 cause 里，沿着 cause 链找错误码。
 */
export function isMessageDataError(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^(22|54)[0-9A-Z]{3}$/.test(code)) return true;
  }
  return false;
}
