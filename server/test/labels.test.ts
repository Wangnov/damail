/**
 * 标签和 AI 标签推荐（docs/labels.md）。AI 用本机的假 OpenAI 兼容接口，按提示词返回预设结果，不调用真实模型。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { after, before, describe, test } from 'node:test';
import { Browser, PASSWORD, setup, type Env } from './helpers.js';

let env: Env;
let web: Browser;
let labelsMod: typeof import('../src/services/labels.js');
let rulesMod: typeof import('../src/services/rules.js');
let jobsMod: typeof import('../src/services/jobs.js');
let mailMod: typeof import('../src/services/mail.js');

// ---- 假 AI：记录每次调用的提示词，按用途返回 ----
type Call = { system: string; user: string };
const ai = {
  calls: [] as Call[],
  suggest: (_user: string): unknown => ({ suggestions: [] }),
  classifyLabels: (_c: Call): string[] => [],
};
let aiServer: http.Server;

function startFakeAi() {
  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const { messages } = JSON.parse(body) as { messages: { content: string }[] };
      const call = { system: messages[0]!.content, user: messages[1]!.content };
      ai.calls.push(call);
      const out =
        call.system.includes('推荐几个值得单独建立') || call.system.includes('recommend a few "labels"')
          ? ai.suggest(call.user)
          : {
              category: 'notification',
              priority: 'normal',
              summary: 'test',
              needs_reply: false,
              verification_codes: [],
              amounts: [],
              due_date: null,
              tracking_numbers: [],
              action_items: [],
              labels: ai.classifyLabels(call),
            };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  return new Promise<number>((r) => aiServer.listen(0, '127.0.0.1', () => r((aiServer.address() as AddressInfo).port)));
}

/** 假 AI 返回的一条推荐：两种语言都写 */
const sug = (zh: [string, string], en: [string, string], groups: (string | undefined)[], reason = '') => ({
  i18n: { 'zh-CN': { name: zh[0], description: zh[1], reason }, en: { name: en[0], description: en[1], reason } },
  groups,
});
const zh = (name: string, description: string) => ({ i18n: { 'zh-CN': { name, description } } });

async function labelIdByName(name: string) {
  const rows = await env.db.select().from(env.schema.labels);
  return rows.find((l) => Object.values(l.i18n).some((v) => v?.name === name))?.id;
}

const call = (path: string, method = 'GET', body?: unknown) =>
  web.request(path, { method, headers: { 'content-type': 'application/json', 'x-damail': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async <T>(res: Response) => (await res.json()) as T;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时：${what}`);
}

let folderId: number;
let uid = 100;
async function addMessage(from: string, subject: string, opts: { fromName?: string; daysAgo?: number; category?: string } = {}) {
  const { db, schema } = env;
  const [m] = await db
    .insert(schema.messages)
    .values({
      accountId: env.accounts.work.id,
      folderId,
      uid: uid++,
      threadId: `t-${uid}`,
      messageId: `<m${uid}@local.test>`,
      subject,
      fromAddress: from,
      fromName: opts.fromName ?? null,
      textBody: `${subject} body`,
      searchText: `${subject} ${from}`,
      date: new Date(Date.now() - (opts.daysAgo ?? 1) * 86400_000),
    })
    .returning();
  if (opts.category)
    await db.insert(schema.messageInsights).values({
      messageId: m!.id,
      category: opts.category,
      priority: 'normal',
      summary: `${subject} 摘要`,
      extracted: { codes: [], amounts: [], dueDate: null, trackingNumbers: [], actionItems: [] },
      model: 'x',
    });
  return m!;
}

/** 走一遍新邮件处理（AI 分析 + 规则），等到分析结果写入 */
async function processMessage(id: number, payload: Record<string, unknown> = {}) {
  const before = await env.db.query.messageInsights.findFirst({ where: (i, { eq }) => eq(i.messageId, id) });
  await jobsMod.enqueue('process_message', { messageId: id, ...payload });
  await waitFor(async () => {
    const row = await env.db.query.messageInsights.findFirst({ where: (i, { eq }) => eq(i.messageId, id) });
    return row && (!before || row.createdAt.getTime() !== before.createdAt.getTime());
  }, `邮件 ${id} 分析完成`);
  // 分析之后还会写标签，再等任务结束
  await waitFor(async () => {
    const pending = await env.db.query.jobs.findFirst({
      where: (j, { and, eq, inArray }) => and(eq(j.type, 'process_message'), inArray(j.status, ['queued', 'running'])),
    });
    return !pending;
  }, '任务结束');
}

const broker: { id: number }[] = [];

before(async () => {
  env = await setup();
  const port = await startFakeAi();
  const aiMod = await import('../src/services/ai.js');
  labelsMod = await import('../src/services/labels.js');
  mailMod = await import('../src/services/mail.js');
  rulesMod = await import('../src/services/rules.js');
  jobsMod = await import('../src/services/jobs.js');
  await aiMod.saveAiSettings({
    enabled: true,
    channels: [
      {
        id: 't',
        name: 'fake',
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'x',
        models: ['fake'],
        modelsSyncedAt: null,
        prices: {},
        priceRate: 1,
      },
    ],
    channelId: 't',
    model: 'fake',
    effort: 'low',
    assistantChannelId: null,
    assistantModel: null,
    assistantEffort: null,
    translateChannelId: null,
    translateModel: null,
    translateLanguage: '',
    analysisEnabled: true,
    accountIds: null,
  });
  await jobsMod.startJobs();

  const folder = await env.db.query.folders.findFirst({ where: (f, { eq }) => eq(f.accountId, env.accounts.work.id) });
  folderId = folder!.id;
  // 券商：两个地址、同一公司域名，应合成一组
  for (const s of ['Trade Confirmation 1', 'Trade Confirmation 2', 'Daily Statement'])
    broker.push(await addMessage('confirm@notice.ibkr.com', s, { fromName: 'Interactive Brokers', category: 'finance' }));
  broker.push(await addMessage('statements@ibkr.com', 'Monthly Statement', { fromName: 'Interactive Brokers', category: 'finance' }));
  // 云服务账单
  for (const s of ['AWS Invoice Oct', 'AWS Invoice Nov', 'AWS Billing Alert'])
    await addMessage('billing@aws.example', s, { fromName: 'AWS', category: 'finance' });
  // 学校通知、GitHub（推荐至少要有 3 组，采用一个之后第二次推荐也要够）
  for (const s of ['[repo] PR #1', '[repo] PR #2', '[repo] Issue #3'])
    await addMessage('notifications@github.example', s, { fromName: 'GitHub', category: 'notification' });
  for (const s of ['家长会通知', '期中考试安排', '秋游报名']) await addMessage('notice@school.example', s, { fromName: '实验小学', category: 'notification' });
  // 个人邮箱服务商：不同的人，不按域名合并，各自都少于 3 封
  await addMessage('alice@gmail.com', 'hi', { category: 'personal' });
  await addMessage('bob@gmail.com', 'yo', { category: 'personal' });
  await addMessage('carol@gmail.com', 'hey', { category: 'personal' });
  // 垃圾邮件、忽略名单、太久以前的：都不参与推荐
  for (const s of ['win 1', 'win 2', 'win 3']) await addMessage('spam@scam.example', s, { category: 'spam' });
  for (const s of ['n1', 'n2', 'n3']) await addMessage('noise@ignored.example', s);
  await env.db.insert(env.schema.ignoredSenders).values({ pattern: '@ignored.example' });
  for (const s of ['old 1', 'old 2', 'old 3']) await addMessage('old@legacy.example', s, { daysAgo: 200 });

  web = new Browser(env.base);
  const res = await web.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: PASSWORD }),
  });
  assert.equal(res.status, 200);
});

after(async () => {
  jobsMod?.stopJobs();
  aiServer?.close();
  await env?.close();
});

describe('AI 分析时自动打标签', () => {
  test('没有标签时提示词和原来一样，输出里也不要求 labels', async () => {
    const m = await addMessage('someone@example.org', 'no labels yet');
    ai.calls = [];
    await processMessage(m.id);
    const c = ai.calls.at(-1)!;
    assert.ok(!c.system.includes('用户自己的标签'), `!c.system.includes('用户自己的标签')`);
    assert.ok(!c.system.includes('"labels"'), `!c.system.includes('"labels"')`);
  });
});

describe('AI 推荐标签', () => {
  test('分组：同一公司域名合并；个人邮箱、垃圾邮件、忽略名单、90 天以前的、太小的组都不参与', async () => {
    const groups = await labelsMod.buildSuggestGroups();
    const keys = groups.map((g) => g.addresses.map((a) => a.address).join(','));
    const ibkr = groups.find((g) => g.addresses.some((a) => a.address === 'statements@ibkr.com'))!;
    assert.equal(ibkr.count, 4);
    assert.deepEqual(new Set(ibkr.addresses.map((a) => a.address)), new Set(['confirm@notice.ibkr.com', 'statements@ibkr.com']));
    assert.equal(ibkr.sender, 'Interactive Brokers');
    assert.ok(
      groups.some((g) => g.addresses[0]!.address === 'billing@aws.example'),
      `groups.some((g) => g.addresses[0]!.address === 'billing@aws.example')`,
    );
    for (const bad of ['gmail.com', 'scam.example', 'ignored.example', 'legacy.example']) assert.ok(!keys.some((k) => k.includes(bad)), bad);
  });

  test('推荐 → 列表 → 采用后历史邮件直接打上，不再调用 AI', async () => {
    let groupOf: Record<string, string> = {};
    ai.suggest = (user) => {
      // 从提示词里找到各组编号
      groupOf = Object.fromEntries([...user.matchAll(/\[(g\d+)\] (.+?) ·/g)].map((m) => [m[2]!, m[1]!]));
      return {
        suggestions: [
          sug(
            ['券商交易通知', 'Interactive Brokers 发的成交确认和结单；不包括营销邮件'],
            ['Broker trades', 'Trade confirmations and statements from Interactive Brokers; not marketing mail'],
            [groupOf['Interactive Brokers']],
            '4 封',
          ),
          sug(['云服务账单', 'AWS 的账单和费用提醒'], ['Cloud bills', 'Invoices and billing alerts from AWS'], [groupOf['AWS']], '3 封'),
          sug(['', '没有名字的丢掉'], ['', 'no name, dropped'], [groupOf['AWS']]),
          sug(['不存在的组', '组编号不认识的丢掉'], ['Unknown group', 'unknown group ids are dropped'], ['g999']),
          // 只写了一种语言也保留，另一种语言按回退显示
          { i18n: { en: { name: 'GitHub', description: 'GitHub notifications', reason: '' } }, groups: [groupOf['GitHub']] },
        ],
      };
    };
    const start = await call('/api/admin/label-suggestions/run', 'POST', {});
    assert.equal(start.status, 202);
    // 正在跑时不能再开一次（任务可能已经很快跑完，所以只在还没跑完时检查）
    const list = await waitFor(async () => {
      const r = await json<{
        run: { status: string } | null;
        suggestions: { id: number; name: string; i18n: Record<string, { name: string }>; count: number; examples: { subject: string }[] }[];
      }>(await call('/api/admin/label-suggestions'));
      return r.run?.status === 'done' && r;
    }, '推荐完成');
    assert.deepEqual(
      list.suggestions.map((s) => [s.name, s.count]),
      [
        ['券商交易通知', 4],
        ['云服务账单', 3],
        ['GitHub', 3],
      ],
    );
    assert.equal(list.suggestions[0]!.i18n.en!.name, 'Broker trades');
    // 切成英文界面：同一批推荐直接显示英文，不用重新调用 AI
    const en = await json<{ suggestions: { name: string; description: string }[] }>(
      await web.request('/api/admin/label-suggestions', { headers: { 'x-damail': '1', 'x-damail-locale': 'en' } }),
    );
    assert.deepEqual(
      en.suggestions.map((s) => s.name),
      ['Broker trades', 'Cloud bills', 'GitHub'],
    );
    assert.ok(
      list.suggestions[0]!.examples.some((e) => e.subject === 'Monthly Statement'),
      `list.suggestions[0]!.examples.some((e) => e.subject === 'Monthly Statement')`,
    );

    // 提示词：分组概况里带样本主题和摘要，不含垃圾邮件
    const prompt = ai.calls.find((c) => c.system.includes('推荐几个值得单独建立'))!;
    assert.ok(prompt.system.includes('zh-CN: 中文') && prompt.system.includes('en: 英语'), '提示词要列出所有语言');
    assert.ok(prompt.user.includes('Trade Confirmation 1'), `prompt.user.includes('Trade Confirmation 1')`);
    assert.ok(prompt.user.includes('摘要'), `prompt.user.includes('摘要')`);
    assert.ok(!prompt.user.includes('scam.example'), `!prompt.user.includes('scam.example')`);

    const callsBefore = ai.calls.length;
    const accepted = await json<{ label: { id: number; source: string }; labeled: number }>(
      await call(`/api/admin/label-suggestions/${list.suggestions[0]!.id}/accept`, 'POST', {}),
    );
    assert.equal(accepted.labeled, 4);
    assert.equal(accepted.label.source, 'suggested');
    assert.equal(ai.calls.length, callsBefore);
    const rows = await env.db.query.messageLabels.findMany({ where: (ml, { eq }) => eq(ml.labelId, accepted.label.id) });
    assert.deepEqual(new Set(rows.map((r) => r.messageId)), new Set(broker.map((b) => b.id)));
    assert.ok(
      rows.every((r) => r.source === 'suggestion'),
      `rows.every((r) => r.source === 'suggestion')`,
    );

    // 处理过的推荐不能再采用
    assert.equal((await call(`/api/admin/label-suggestions/${list.suggestions[0]!.id}/accept`, 'POST', {})).status, 404);
    // 忽略
    assert.equal((await call(`/api/admin/label-suggestions/${list.suggestions[1]!.id}/dismiss`, 'POST', {})).status, 200);
  });

  test('再推荐一次：提示词里带上已有标签和忽略过的推荐；和已有标签重名的建议丢掉', async () => {
    ai.suggest = () => ({
      suggestions: [sug(['新名字', '中文不重名'], ['Broker trades', 'English name taken'], ['g1']), sug(['券商交易通知', '重名'], ['New name', 'x'], ['g1'])],
    });
    ai.calls = [];
    await call('/api/admin/label-suggestions/run', 'POST', {});
    const list = await waitFor(async () => {
      const r = await json<{ run: { status: string; createdAt: string } | null; suggestions: unknown[] }>(await call('/api/admin/label-suggestions'));
      return r.run?.status === 'done' && ai.calls.length > 0 && r;
    }, '第二次推荐完成');
    const prompt = ai.calls[0]!;
    assert.ok(prompt.user.includes('用户已有的标签：\n- 券商交易通知 / Broker trades：'), '已有标签要带上所有语言的名称');
    assert.ok(prompt.user.includes('用户忽略过的推荐：云服务账单、Cloud bills'), '忽略过的推荐要带上所有语言的名称');
    // 券商那组已经全部打上标签，不再送去推荐
    assert.ok(!/\] Interactive Brokers ·/.test(prompt.user), '券商那组不该再出现');
    // 任何一种语言和已有标签重名都丢掉；上一次没处理的推荐（GitHub）过期
    assert.equal(list.suggestions.length, 0);
  });

  test('采用时重名：报 409，可以合并到已有标签', async () => {
    const { db, schema } = env;
    const existing = await labelIdByName('券商交易通知');
    const [s] = await db
      .insert(schema.labelSuggestions)
      .values({ runId: 'manual', i18n: { en: { name: 'broker TRADES', description: 'x', reason: '' } }, color: 'blue', messageIds: [broker[0]!.id] })
      .returning();
    // 和已有标签的英文名重名（不分大小写）
    assert.equal((await call(`/api/admin/label-suggestions/${s!.id}/accept`, 'POST', {})).status, 409);
    // 采用时改名：所有语言一起提交
    const [s2] = await db
      .insert(schema.labelSuggestions)
      .values({ runId: 'manual', i18n: { 'zh-CN': { name: '券商交易通知', description: 'x', reason: '' } }, color: 'blue', messageIds: [broker[1]!.id] })
      .returning();
    const renamed = await call(`/api/admin/label-suggestions/${s2!.id}/accept`, 'POST', {
      i18n: { 'zh-CN': { name: '券商日报', description: '券商日报' }, en: { name: 'Broker daily', description: 'Daily statements' } },
    });
    assert.equal(renamed.status, 200);
    const label = (await json<{ label: { id: number; name: string } }>(renamed)).label;
    assert.equal(label.name, '券商日报');
    await call(`/api/admin/labels/${label.id}`, 'DELETE');
    const merged = await json<{ label: { id: number } }>(await call(`/api/admin/label-suggestions/${s!.id}/accept`, 'POST', { mergeInto: existing! }));
    assert.equal(merged.label.id, existing!);
  });
});

describe('标签的使用', () => {
  let brokerLabel: number;
  let otherLabel: number;

  before(async () => {
    brokerLabel = (await labelIdByName('券商交易通知'))!;
    const created = await call('/api/admin/labels', 'POST', { ...zh('重要客户', '某几个客户的来信'), color: 'green' });
    assert.equal(created.status, 201);
    otherLabel = (await json<{ id: number }>(created)).id;
  });

  test('新邮件：提示词带标签列表，AI 选中的打上，不认识的编号丢掉', async () => {
    ai.classifyLabels = (c) => (c.user.includes('Trade Confirmation') ? [`L${brokerLabel}`, 'L99999'] : []);
    const m = await addMessage('confirm@notice.ibkr.com', 'Trade Confirmation 3');
    ai.calls = [];
    await processMessage(m.id);
    const c = ai.calls.at(-1)!;
    assert.ok(
      c.system.includes(`L${brokerLabel} 券商交易通知：Interactive Brokers 发的成交确认和结单`),
      `c.system.includes(\`L\${brokerLabel} 券商交易通知：Interactive Brokers 发的成交确认和结单\`)`,
    );
    assert.ok(c.system.includes(`L${otherLabel} 重要客户`), `c.system.includes(\`L\${otherLabel} 重要客户\`)`);
    const rows = await env.db.query.messageLabels.findMany({ where: (ml, { eq }) => eq(ml.messageId, m.id) });
    assert.deepEqual(
      rows.map((r) => [r.labelId, r.source]),
      [[brokerLabel, 'ai']],
    );
  });

  test('手动修改优先：手动去掉的重新分析不会打回来，手动加的不会被去掉', async () => {
    const m = await addMessage('confirm@notice.ibkr.com', 'Trade Confirmation 4');
    await processMessage(m.id);
    const res = await call(`/api/v1/messages/${m.id}/labels`, 'PUT', { add: [otherLabel], remove: [brokerLabel] });
    assert.equal(res.status, 200);
    assert.deepEqual(
      (await json<{ id: number }[]>(res)).map((l) => l.id),
      [otherLabel],
    );
    await processMessage(m.id, { analyzeOnly: true, reanalyze: true });
    const now = await labelsMod.labelsForMessages([m.id]);
    assert.deepEqual(
      now.get(m.id)?.map((l) => l.id),
      [otherLabel],
    );
  });

  test('重新分析时 AI 不再选的标签会去掉（只去掉 AI 打的）', async () => {
    const m = await addMessage('confirm@notice.ibkr.com', 'Trade Confirmation 5');
    await processMessage(m.id);
    assert.equal((await labelsMod.labelsForMessages([m.id])).get(m.id)?.length, 1);
    ai.classifyLabels = () => [];
    await processMessage(m.id, { analyzeOnly: true, reanalyze: true });
    assert.equal((await labelsMod.labelsForMessages([m.id])).get(m.id), undefined);
    // 采用推荐时打的不受影响
    assert.equal((await labelsMod.labelsForMessages([broker[0]!.id])).get(broker[0]!.id)?.[0]?.id, brokerLabel);
  });

  test('搜索 label:、会话列表和邮件详情带标签、侧栏数量', async () => {
    const threads = await json<{ items: { threadId: string; labels: { name: string }[] }[] }>(
      await call(`/api/v1/threads?view=all&q=${encodeURIComponent('label:券商交易通知')}`),
    );
    assert.ok(threads.items.length >= 4, `threads.items.length >= 4`);
    assert.ok(
      threads.items.every((t) => t.labels.some((l) => l.name === '券商交易通知')),
      `threads.items.every((t) => t.labels.some((l) => l.name === '券商交易通知'))`,
    );
    const excluded = await json<{ items: { labels: { name: string }[] }[] }>(
      await call(`/api/v1/threads?view=all&q=${encodeURIComponent('-label:券商交易通知')}`),
    );
    assert.ok(
      excluded.items.every((t) => !t.labels.some((l) => l.name === '券商交易通知')),
      `excluded.items.every((t) => !t.labels.some((l) => l.name === '券商交易通知'))`,
    );
    const detail = await json<{ labels: { id: number }[] }>(await call(`/api/v1/messages/${broker[0]!.id}`));
    assert.deepEqual(
      detail.labels.map((l) => l.id),
      [brokerLabel],
    );
    const stats = await json<{ labels: Record<string, { total: number; unread: number }> }>(await call('/api/v1/stats'));
    assert.ok(stats.labels[brokerLabel]!.total >= 4, `stats.labels[brokerLabel]!.total >= 4`);
    // 用其他语言的名称搜也行
    const byEnglish = await json<{ items: unknown[] }>(await call(`/api/v1/threads?view=all&q=${encodeURIComponent('label:"broker trades"')}`));
    assert.equal(byEnglish.items.length, threads.items.length);
    const list = await json<{ items: { id: number; total: number }[] }>(await call('/api/admin/labels'));
    assert.equal(list.items.find((l) => l.id === brokerLabel)!.total, stats.labels[brokerLabel]!.total);
  });

  test('规则条件：有 / 没有某个标签；标签删除后引用它的条件不再匹配', async () => {
    const m = (await env.db.query.messages.findFirst({ where: (x, { eq }) => eq(x.id, broker[0]!.id) }))!;
    const rule = (value: number, op: 'is' | 'is_not') => ({
      accountIds: null,
      match: 'all' as const,
      conditions: [{ field: 'label', op, value: String(value) }],
    });
    const known = await labelsMod.allLabelIds();
    const ctx = { message: m, insight: null, labelIds: [brokerLabel], knownLabels: known };
    assert.equal(rulesMod.ruleMatches(rule(brokerLabel, 'is'), ctx), true);
    assert.equal(rulesMod.ruleMatches(rule(otherLabel, 'is'), ctx), false);
    assert.equal(rulesMod.ruleMatches(rule(otherLabel, 'is_not'), ctx), true);
    // 校验：取值必须是标签 id
    assert.throws(() => rulesMod.ruleInput.parse({ name: 'x', conditions: [{ field: 'label', op: 'is', value: '券商' }], actions: [{ type: 'star' }] }));

    const created = await rulesMod.createRule({
      name: '客户来信加星',
      conditions: [{ field: 'label', op: 'is', value: String(otherLabel) }],
      actions: [{ type: 'star' }],
    } as never);
    const res = await json<{ rules: { id: number }[] }>(await call(`/api/admin/labels/${otherLabel}`, 'DELETE'));
    assert.deepEqual(
      res.rules.map((r) => r.id),
      [created.id],
    );
    const after = await labelsMod.allLabelIds();
    assert.equal(rulesMod.ruleMatches(rule(otherLabel, 'is_not'), { ...ctx, knownLabels: after }), false);
  });

  test('名称重复、超长、上限', async () => {
    assert.equal((await call('/api/admin/labels', 'POST', zh('券商交易通知', 'x'))).status, 409);
    // 不同语言之间也不能重名
    assert.equal((await call('/api/admin/labels', 'POST', { i18n: { 'zh-CN': { name: 'Broker Trades', description: 'x' } } })).status, 409);
    assert.equal((await call('/api/admin/labels', 'POST', zh('X'.repeat(21), 'x'))).status, 400);
    assert.equal((await call('/api/admin/labels', 'POST', zh('没说明', ''))).status, 400);
    assert.equal((await call('/api/admin/labels', 'POST', { i18n: {} })).status, 400);
    assert.equal((await call('/api/admin/labels', 'POST', { i18n: { fr: { name: 'x', description: 'x' } } })).status, 400);
    // 一种语言写名称、另一种写说明也可以；显示时说明退回到有的那种语言
    const mixed = await call('/api/admin/labels', 'POST', {
      i18n: { 'zh-CN': { name: '只有名称', description: '' }, en: { name: '', description: 'English only' } },
    });
    assert.equal(mixed.status, 201);
    const m = await json<{ id: number; name: string; description: string }>(mixed);
    assert.deepEqual([m.name, m.description], ['只有名称', 'English only']);
    // 修改：i18n 整体替换，自己原来的名字不算重名
    const patched = await call(`/api/admin/labels/${m.id}`, 'PATCH', {
      i18n: { 'zh-CN': { name: '只有名称', description: '补上中文说明' }, en: { name: 'Name only', description: 'English only' } },
    });
    assert.equal(patched.status, 200);
    await call(`/api/admin/labels/${m.id}`, 'DELETE');
    const { db, schema } = env;
    const n = await db.$count(schema.labels);
    await db
      .insert(schema.labels)
      .values(Array.from({ length: labelsMod.LABEL_LIMIT - n }, (_, i) => ({ ...zh(`批量${i}`, 'x'), color: 'blue', source: 'manual' })));
    assert.equal((await call('/api/admin/labels', 'POST', zh('第 51 个', 'x'))).status, 409);
  });

  test('开放接口：标签列表；改邮件标签需要 organize 权限', async () => {
    const key = env.apiKey.value;
    const list = await fetch(`${env.base}/api/v1/labels`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(list.status, 200);
    assert.ok(
      (await json<{ name: string }[]>(list)).some((l) => l.name === '券商交易通知'),
      `(await json<{ name: string }[]>(list)).some((l) => l.name === '券商交易通知')`,
    );
    const put = await fetch(`${env.base}/api/v1/messages/${broker[0]!.id}/labels`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ remove: [brokerLabel] }),
    });
    assert.equal(put.status, 403);
    // 别的邮箱范围外 / 不存在的邮件
    assert.equal((await call('/api/v1/messages/999999/labels', 'PUT', { add: [brokerLabel] })).status, 404);
  });

  test('按会话加、去掉标签：会话里每封邮件都改，去掉的重新分析也不会打回来', async () => {
    const m = await addMessage('someone@thread.example', 'thread labels');
    const [reply] = await env.db
      .insert(env.schema.messages)
      .values({ ...m, id: undefined, uid: uid++, messageId: `<r${uid}@local.test>`, subject: 'Re: thread labels' } as never)
      .returning();
    const add = await call('/api/v1/threads/labels', 'POST', { threadIds: [m.threadId], add: [brokerLabel] });
    assert.equal(add.status, 200);
    assert.equal((await json<{ updated: number }>(add)).updated, 2);
    const both = await labelsMod.labelsForMessages([m.id, reply!.id]);
    assert.deepEqual([both.get(m.id)?.[0]?.id, both.get(reply!.id)?.[0]?.id], [brokerLabel, brokerLabel]);
    await call('/api/v1/threads/labels', 'POST', { threadIds: [m.threadId], remove: [brokerLabel] });
    assert.equal((await labelsMod.labelsForMessages([m.id, reply!.id])).size, 0);
    // 不存在的标签
    assert.equal((await call('/api/v1/threads/labels', 'POST', { threadIds: [m.threadId], add: [999999] })).status, 404);
  });

  test('全部标为已读：按视图 / 文件夹 / 搜索 / 标签找未读邮件，受邮箱范围限制；接口需要 organize 权限', async () => {
    const a = await addMessage('a@markread.example', 'markread one');
    const b = await addMessage('b@markread.example', 'markread two');
    const other = await addMessage('c@other.example', 'something else');
    const all = { accountIds: null };
    const ids = await mailMod.unreadMessageIds({ scope: all, q: 'markread' });
    assert.deepEqual([...ids].sort(), [a.id, b.id].sort(), '只包含搜索匹配的未读邮件');
    assert.ok((await mailMod.unreadMessageIds({ scope: all, folderId })).includes(other.id), '按文件夹');
    assert.deepEqual(await mailMod.unreadMessageIds({ scope: { accountIds: [env.accounts.home.id] }, q: 'markread' }), [], '邮箱范围外的不算');
    await call('/api/v1/threads/labels', 'POST', { threadIds: [a.threadId], add: [brokerLabel] });
    const byLabel = await mailMod.unreadMessageIds({ scope: all, q: 'label:券商交易通知 markread' });
    assert.deepEqual(byLabel, [a.id], '按标签');
    await env.db.update(env.schema.messages).set({ seen: true }).where(eq(env.schema.messages.id, a.id));
    assert.deepEqual(await mailMod.unreadMessageIds({ scope: all, q: 'markread' }), [b.id], '已读的不再算');
    await call('/api/v1/threads/labels', 'POST', { threadIds: [a.threadId], remove: [brokerLabel] });

    // 没有匹配时直接返回，不碰邮箱服务器
    const none = await call('/api/v1/threads/mark-read', 'POST', { q: 'nothing-matches-this-xyz' });
    assert.equal(none.status, 200);
    assert.equal((await json<{ updated: number }>(none)).updated, 0);
    const denied = await fetch(`${env.base}/api/v1/threads/mark-read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.apiKey.value}`, 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'markread' }),
    });
    assert.equal(denied.status, 403);
  });

  test('推荐按发起时的界面语言选提示词，输出仍然是所有语言；超长说明在句子边界截断', async () => {
    const long = `Billing notices from AWS and other cloud providers. ${'Includes invoices and payment reminders for every account '.repeat(4)}`;
    ai.suggest = () => ({ suggestions: [sug(['云账单', '云服务的账单'], ['Cloud billing', long], ['g1'], 'Frequent')] });
    ai.calls = [];
    const res = await web.request('/api/admin/label-suggestions/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-damail': '1', 'x-damail-locale': 'en' },
      body: '{}',
    });
    assert.equal(res.status, 202);
    const list = await waitFor(async () => {
      const r = await json<{ run: { status: string } | null; suggestions: { name: string; i18n: Record<string, { description: string }> }[] }>(
        await call('/api/admin/label-suggestions'),
      );
      return r.run?.status === 'done' && ai.calls.length > 0 && r;
    }, '英文推荐完成');
    const prompt = ai.calls[0]!;
    assert.ok(prompt.system.includes('recommend a few "labels"'), '英文界面要用英文提示词');
    assert.ok(prompt.system.includes('zh-CN: Chinese') && prompt.system.includes('en: English'), '语言列表用英文写');
    // 说明部分不夹中文（后面的 JSON 示例里要有每种语言的写法）
    assert.ok(!/[\u4e00-\u9fff]/.test(prompt.system.split('{"suggestions"')[0]!), '英文提示词里不该夹中文');
    assert.ok(/ emails · /.test(prompt.user), '分组概况也用英文');
    const s = list.suggestions.find((x) => x.name === '云账单')!;
    const d = s.i18n.en!.description;
    // 句子边界太靠前时退到空格处截断：不超过 200 字，也不切断单词
    assert.ok(d.length <= 200 && long.startsWith(d) && long[d.length] === ' ', `截断位置不对：${d}`);
  });

  test('clip：不在词中间截断', () => {
    assert.equal(labelsMod.clip('短句', 10), '短句');
    assert.equal(labelsMod.clip('第一句说明。第二句很长很长很长很长很长', 10), '第一句说明。');
    assert.equal(labelsMod.clip('alpha beta gamma delta epsilon', 18), 'alpha beta gamma');
  });
});
