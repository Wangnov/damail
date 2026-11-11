import { and, eq, inArray } from 'drizzle-orm';
import render from 'dom-serializer';
import { isTag, isText, type AnyNode, type Text } from 'domhandler';
import { convert as htmlToText } from 'html-to-text';
import { parseDocument } from 'htmlparser2';
import { z } from 'zod';
import { db } from '../db/index.js';
import { messages, messageTranslations, type MessageTranslation } from '../db/schema.js';
import { L } from '../i18n/index.js';
import { prompt } from './catalog.js';
import { ActionError } from './actions.js';
import { generateJson, getAiSettings, getTranslateAiConfig } from './ai.js';
import { inScope, type Scope } from './mail.js';

type TranslateConfig = Awaited<ReturnType<typeof getTranslateAiConfig>>;

// 纯文本邮件太长时只翻前面一段，避免输出被截断
const MAX_TEXT_CHARS = 12_000;
// HTML 邮件按文字片段分批翻译，每批的字数和总字数上限；超出的片段保留原文
const BATCH_CHARS = 4_000;
const MAX_HTML_CHARS = 40_000;
const CONCURRENCY = 4;

// 系统提示词在 prompts 表（translate.text / translate.segment），按当前语言取

const textSchema = z.object({ subject: z.string(), body: z.string() });
const segmentSchema = z.object({ items: z.array(z.object({ id: z.string(), text: z.string() })) });

export type TranslationBrief = Pick<MessageTranslation, 'language' | 'subject' | 'body' | 'html' | 'model' | 'createdAt'>;

const brief = (t: MessageTranslation): TranslationBrief => ({
  language: t.language,
  subject: t.subject,
  body: t.body,
  html: t.html,
  model: t.model,
  createdAt: t.createdAt,
});

/** 会话详情里附带当前目标语言的译文 */
export async function translationsFor(messageIds: number[]) {
  if (!messageIds.length) return new Map<number, TranslationBrief>();
  const { translateLanguage } = await getAiSettings();
  const rows = await db
    .select()
    .from(messageTranslations)
    .where(and(inArray(messageTranslations.messageId, messageIds), eq(messageTranslations.language, translateLanguage)));
  return new Map(rows.map((r) => [r.messageId, brief(r)]));
}

async function run<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    throw new ActionError(L(`翻译失败：${(err as Error).message}`, `Translation failed: ${(err as Error).message}`));
  }
}

/** 纯文本邮件：整段翻译，要求逐行对应 */
async function translateText(cfg: TranslateConfig, subject: string, text: string) {
  const body = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…（正文过长，后续内容未翻译）` : text;
  const user = [`目标语言：${cfg.language}`, '', '<subject>', subject, '</subject>', '', '<email_body>', body, '</email_body>'].join('\n');
  const out = await run(() =>
    generateJson(prompt('translate.text'), user, textSchema, {
      purpose: 'translate',
      shape: '{"subject": "译文主题", "body": "译文正文"}',
      maxTokens: 16_000,
      effort: 'low',
      config: cfg,
    }),
  );
  return { subject: out.subject.trim(), body: out.body.trim(), html: null };
}

// 这些标签里的文字不显示或不该翻译
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript', 'code']);
const CJK = /[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/;
const ONLY_LINK = /^(https?:\/\/\S+|[\w.+-]+@[\w-]+(\.[\w-]+)+)$/i;

function collectText(nodes: AnyNode[], out: Text[]) {
  for (const n of nodes) {
    if (isText(n)) {
      const t = n.data.trim();
      if (t && /\p{L}/u.test(t) && !ONLY_LINK.test(t)) out.push(n);
    } else if (isTag(n) && !SKIP_TAGS.has(n.name.toLowerCase())) collectText(n.children, out);
  }
}

/** 把片段按字数分批；超过总上限的片段不翻译 */
function batches(items: Array<{ id: string; text: string }>) {
  const result: Array<typeof items> = [];
  let cur: typeof items = [];
  let size = 0;
  let total = 0;
  for (const it of items) {
    total += it.text.length;
    if (total > MAX_HTML_CHARS) break;
    if (cur.length && size + it.text.length > BATCH_CHARS) {
      result.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += it.text.length;
  }
  if (cur.length) result.push(cur);
  return result;
}

/** HTML 邮件：只替换文字节点，标签、样式、图片、链接都不动，排版和原邮件一样 */
async function translateHtml(cfg: TranslateConfig, subject: string, html: string) {
  const doc = parseDocument(html);
  const nodes: Text[] = [];
  collectText(doc.children, nodes);

  // 相同的文字只翻一次；主题作为第 0 项放在第一批里一起翻
  const unique = [...new Set(nodes.map((n) => n.data.trim()))];
  const idOf = new Map(unique.map((text, i) => [text, String(i + 1)]));
  const items = [{ id: '0', text: subject }, ...unique.map((text) => ({ id: idOf.get(text)!, text }))].filter((it) => it.text.trim());
  const groups = batches(items);
  const translated = new Map<string, string>();
  for (let i = 0; i < groups.length; i += CONCURRENCY) {
    await Promise.all(
      groups.slice(i, i + CONCURRENCY).map(async (group) => {
        const user = `目标语言：${cfg.language}\n\n${JSON.stringify(group)}`;
        const out = await run(() =>
          generateJson(prompt('translate.segment'), user, segmentSchema, {
            purpose: 'translate',
            shape: '{"items": [{"id": "片段 id", "text": "译文"}]}',
            maxTokens: 16_000,
            effort: 'low',
            config: cfg,
          }),
        );
        for (const it of out.items) translated.set(it.id, it.text);
      }),
    );
  }

  for (const n of nodes) {
    const src = n.data.trim();
    const t = translated.get(idOf.get(src)!);
    if (!t) continue;
    // 保留原来首尾的空白，避免和相邻的链接、加粗粘在一起；译文边上是中日韩文字时不需要空格
    const [, lead, , trail] = n.data.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    const text = t.trim();
    n.data = `${CJK.test(text[0] ?? '') ? '' : lead}${text}${CJK.test(text.at(-1) ?? '') ? '' : trail}`;
  }
  const out = render(doc, { encodeEntities: 'utf8' });
  return {
    subject: (translated.get('0') ?? subject).trim(),
    body: htmlToText(out, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }),
    html: out,
  };
}

/** 翻译一封邮件并保存；已经翻译过的直接返回，force 时重新翻译 */
export async function translateMessage(scope: Scope, messageId: number, opts: { force?: boolean } = {}) {
  const m = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!m || !inScope(scope, m.accountId)) return null;
  const cfg = await getTranslateAiConfig();
  if (!opts.force) {
    const saved = await db.query.messageTranslations.findFirst({
      where: and(eq(messageTranslations.messageId, m.id), eq(messageTranslations.language, cfg.language)),
    });
    if (saved) return brief(saved);
  }
  if (!cfg.enabled) throw new ActionError(L('AI 未启用，请先在「智能 › 模型配置」里启用', 'AI is not enabled. Turn it on under AI › Models'), 400);
  if (!cfg.apiKey) throw new ActionError(L('翻译用的渠道还没有 API Key', 'The translation channel has no API key'), 400);

  const res = m.htmlBody ? await translateHtml(cfg, m.subject, m.htmlBody) : await translateText(cfg, m.subject, (m.textBody ?? '').trim());
  const row = { messageId: m.id, language: cfg.language, ...res, model: cfg.model, createdAt: new Date() };
  await db
    .insert(messageTranslations)
    .values(row)
    .onConflictDoUpdate({ target: [messageTranslations.messageId, messageTranslations.language], set: row });
  return brief(row);
}
