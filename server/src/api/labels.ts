import { Hono } from 'hono';
import { z } from 'zod';
import { actorOf, requireSession, type AppEnv } from '../auth/index.js';
import { audit } from '../lib/audit.js';
import {
  acceptSuggestion,
  backfillLabel,
  createLabel,
  deleteLabel,
  dismissSuggestion,
  LABEL_COLORS,
  LABEL_LIMIT,
  labelText,
  listLabels,
  listSuggestions,
  rulesUsingLabel,
  startLabelSuggestions,
  updateLabel,
} from '../services/labels.js';
import { listPrompts } from '../services/catalog.js';

const id = (v: string) => z.coerce.number().int().positive().parse(v);

/** 标签管理和 AI 推荐（网页登录态）；邮件上的标签增减在 /api/v1/messages/:id/labels */
export const labelAdminRoutes = new Hono<AppEnv>()
  .use(requireSession())
  .get('/labels', async (c) => {
    const list = await listLabels(c.var.auth.scope);
    return c.json({ items: list, limit: LABEL_LIMIT, colors: LABEL_COLORS });
  })
  .post('/labels', async (c) => {
    const label = await createLabel(await c.req.json());
    audit(actorOf(c.var.auth), 'label.create', { target: `label:${label.id}`, detail: { name: labelText(label.i18n).name } });
    return c.json({ ...label, ...labelText(label.i18n) }, 201);
  })
  .get('/labels/:id/rules', async (c) => c.json(await rulesUsingLabel(id(c.req.param('id')))))
  .patch('/labels/:id', async (c) => {
    const label = await updateLabel(id(c.req.param('id')), await c.req.json());
    audit(actorOf(c.var.auth), 'label.update', { target: `label:${label.id}` });
    return c.json({ ...label, ...labelText(label.i18n) });
  })
  .delete('/labels/:id', async (c) => {
    const labelId = id(c.req.param('id'));
    const res = await deleteLabel(labelId);
    audit(actorOf(c.var.auth), 'label.delete', { target: `label:${labelId}` });
    return c.json(res);
  })
  .post('/labels/:id/backfill', async (c) => {
    const { days } = z.object({ days: z.number().int().min(1).max(365).default(30) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await backfillLabel(id(c.req.param('id')), days));
  })
  .get('/label-suggestions', async (c) => c.json(await listSuggestions(c.var.auth.scope)))
  .post('/label-suggestions/run', async (c) => {
    const res = await startLabelSuggestions();
    audit(actorOf(c.var.auth), 'label.suggest', {});
    return c.json(res, 202);
  })
  .post('/label-suggestions/:id/accept', async (c) => {
    const res = await acceptSuggestion(id(c.req.param('id')), await c.req.json().catch(() => ({})));
    audit(actorOf(c.var.auth), 'label.accept', { target: `label:${res.label.id}`, detail: { name: res.label.name, labeled: res.labeled } });
    return c.json(res);
  })
  .post('/label-suggestions/:id/dismiss', async (c) => c.json(await dismissSuggestion(id(c.req.param('id')))))
  // 系统内置的提示词（只读）：所有语言的正文和可用变量
  .get('/prompts', (c) => c.json(listPrompts()));
