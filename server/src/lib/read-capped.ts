/**
 * 边下载边计数读取响应体，超过 maxBytes 立即中断，内存里最多保留 maxBytes 左右。
 * 返回已读到的数据、是否超限，以及完整大小（优先取 Content-Length，没有时就是已读字节数）。
 */
// 全局 fetch 和 undici 的 Response 类型不兼容，只取用到的部分
type BodyResponse = { headers: { get(name: string): string | null }; body: unknown };

export async function readCapped(res: BodyResponse, maxBytes: number): Promise<{ data: Buffer; overflow: boolean; total: number }> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  const chunks: Buffer[] = [];
  let read = 0;
  let overflow = false;
  if (res.body) {
    // 提前 break 时 for await 会取消底层的流，不再继续下载
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
      read += chunk.byteLength;
      if (read > maxBytes) {
        overflow = true;
        break;
      }
    }
  }
  const data = Buffer.concat(chunks, read);
  return { data, overflow, total: Number.isFinite(declared) && declared > read ? declared : read };
}
