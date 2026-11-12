/**
 * 把 HTML 里的 cid: 引用改写成附件地址，只扫描一遍：
 * 逐个附件全文替换在附件很多时是乘法级的开销，恶意邮件能借此卡死页面。
 * Content-ID 不区分大小写；没有对应附件的 cid: 原样保留。
 */
export function rewriteCids(html: string, attachments: Array<{ cid?: string | null; index: number }>, urlFor: (index: number) => string): string {
  const cids = new Map<string, string>();
  for (const att of attachments) {
    const key = att.cid?.toLowerCase();
    if (key && !cids.has(key)) cids.set(key, urlFor(att.index));
  }
  if (!cids.size) return html;
  return html.replace(/cid:([^\s"'<>()]+)/gi, (m, id: string) => cids.get(id.toLowerCase()) ?? m);
}
