/**
 * 更新说明的解析和输出，没有 Node 依赖：构建脚本（release-info.mjs）、发布命令（scripts/release.mjs）、
 * GitHub Actions 生成 Release 正文、前端解析 GitHub Release 正文都用这一份。
 *
 * 写法（标签附注 / GitHub Release 正文）：
 * - 第一行如果是标题（含标签名，例如「DaMail v0.2.0」）不显示
 * - 不带「- 」的行是简介；紧跟着「- 要点」的那行是小节标题；「### 标题」也算小节标题
 * - 含中文的行算中文，其余算英文；某种语言没写时两种语言都显示写了的那种
 * - 单独一行「---」之后的内容不算更新说明（Release 正文末尾的镜像地址等）
 */
const CJK = /[㐀-鿿]/;
const BULLET = /^[-*•]\s+/;
const HEADING = /^#{1,6}\s+/;

/** 更新说明 → { zh, en }，每份是 { intro: 简介段落[], sections: [{ title, items[] }] }；什么都没写时返回 null */
export function parseNotes(tag, message) {
  const lines = String(message ?? '')
    .replace(/\r/g, '')
    .split('\n');
  const end = lines.findIndex((l) => l.trim() === '---');
  const toks = (end >= 0 ? lines.slice(0, end) : lines).map((raw) => {
    const t = raw.trim();
    if (!t) return { k: 'blank' };
    if (HEADING.test(t)) {
      const text = t.replace(HEADING, '');
      return { k: 'heading', text, zh: CJK.test(text) };
    }
    const item = BULLET.test(t);
    const text = t.replace(BULLET, '');
    return { k: item ? 'item' : 'text', text, zh: CJK.test(text) };
  });
  const firstText = toks.findIndex((x) => x.k !== 'blank');
  if (firstText >= 0 && toks[firstText].k !== 'item' && tag && toks[firstText].text.includes(tag)) toks.splice(firstText, 1);

  const build = (zh) => {
    const list = toks.filter((x) => x.k === 'blank' || x.zh === zh);
    const intro = [];
    const sections = [];
    let cur = null;
    list.forEach((x, i) => {
      if (x.k === 'blank') {
        // 「### 标题」和要点之间空一行也算同一节
        if (cur && cur.items.length) cur = null;
      } else if (x.k === 'heading') sections.push((cur = { title: x.text, items: [] }));
      else if (x.k === 'text') {
        if (list[i + 1]?.k === 'item') sections.push((cur = { title: x.text, items: [] }));
        else {
          intro.push(x.text);
          cur = null;
        }
      } else {
        if (!cur) sections.push((cur = { title: null, items: [] }));
        cur.items.push(x.text);
      }
    });
    const kept = sections.filter((s) => s.items.length);
    return intro.length || kept.length ? { intro, sections: kept } : null;
  };
  const zh = build(true);
  const en = build(false);
  if (!zh && !en) return null;
  return { zh: zh ?? en, en: en ?? zh };
}

/** 标签附注的第一行是标题（含标签名）时用它，否则用「DaMail <tag>」 */
export function notesTitle(tag, message) {
  const first = String(message ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return first && first.includes(tag) && !BULLET.test(first) ? first : `DaMail ${tag}`;
}

const block = (notes) =>
  [...notes.intro.map((p) => `${p}\n`), ...notes.sections.map((s) => `${s.title ? `### ${s.title}\n` : ''}${s.items.map((x) => `- ${x}`).join('\n')}\n`)].join(
    '\n',
  );

/**
 * 标签附注 → GitHub Release 正文（Markdown）：小节标题换成「### 标题」，中文在前英文在后，
 * 末尾「---」之后附上镜像地址。前端用 parseNotes 读回来时会忽略「---」之后的部分。
 */
export function notesMarkdown(tag, message, { image } = {}) {
  const notes = parseNotes(tag, message);
  const parts = [];
  if (notes) {
    parts.push(block(notes.zh));
    if (notes.en !== notes.zh) parts.push(block(notes.en));
  }
  if (image) {
    parts.push('---\n');
    parts.push(`**Docker**\n\n\`\`\`bash\ndocker pull ${image}:${tag}\n\`\`\`\n`);
  }
  return parts.join('\n').trim() + '\n';
}
