const BLOCK = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'TR',
  'TABLE',
  'BLOCKQUOTE',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'UL',
  'OL',
  'PRE',
]);

/** HTML 源码模式下生成纯文本正文（text/plain 部分）：DOMParser 解析不会执行脚本，也不加载图片 */
export function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? '').replace(/\s+/g, ' ');
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD' || tag === 'TITLE') return;
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    if (tag === 'LI') out += '\n• ';
    if (tag === 'TD' || tag === 'TH') out += '\t';
    node.childNodes.forEach(walk);
    if (tag === 'A') {
      const href = node.getAttribute('href');
      if (href && /^https?:/i.test(href) && !node.textContent?.includes(href)) out += ` (${href})`;
    }
    if (BLOCK.has(tag)) out += '\n';
  };
  walk(doc.body);
  return out
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 可视化编辑器的 HTML 切到源码模式时，在块级标签后换行，方便阅读 */
export function prettyHtml(html: string) {
  return html
    .replace(/(<\/(?:p|h[1-6]|li|ul|ol|blockquote|tr|table|thead|tbody|div)>)(?!\n)/g, '$1\n')
    .replace(/(<(?:ul|ol|table|tbody|thead|tr)(?:\s[^>]*)?>)(?!\n)/g, '$1\n')
    .trim();
}
