import { z } from 'zod';

export const categories = ['个人学习', '论文研究', '项目知识', '故障经验', '团队百科'];
export const masteryValues = ['未评估', '理解中', '可独立完成', '需复习'];
const uuid = z.string().uuid();
const reference = uuid.nullable().optional();
const title = z.string().trim().min(1, '请输入标题').max(200);
const text = z.string().trim().max(30000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, '日期无效');
export const schemas = {
  password: z.object({ password: z.string().min(8, '密码至少需要 8 个字符').max(200) }),
  source: z.object({ title: title.optional(), category: z.enum(categories).optional(), read_progress: z.number().int().min(0).max(100).optional() }),
  note: z.object({ title, content: text, source_id: uuid, chunk_id: reference }),
  knowledge: z.object({ title, summary: text, tags: z.array(z.string().trim().min(1).max(30)).max(15).default([]), prerequisites: z.array(uuid).max(30).default([]), source_id: reference, chunk_id: reference, mastery: z.enum(masteryValues).default('未评估'), draft: z.boolean().default(false), due_at: date.nullable().optional() }),
  skill: z.object({ title, description: text, criteria: text, knowledge_ids: z.array(uuid).max(50).default([]), status: z.enum(['学习中', '可独立完成', '需练习']).default('学习中'), evidence: text.default('') }),
  plan: z.object({ title, goal: text, due_date: date.nullable().optional(), source_id: reference, steps: z.array(z.object({ id: uuid, title, done: z.boolean() })).max(100) }),
  practice: z.object({ knowledge_id: uuid, prompt: title.optional() }),
  answer: z.object({ answer: z.string().trim().min(1, '请先填写回答').max(20000) }),
  review: z.object({ rating: z.enum(['again', 'hard', 'good', 'easy']) }),
  conversation: z.object({ title: title.default('新的学习对话'), source_id: reference }),
  message: z.object({ content: z.string().trim().min(1).max(6000) }),
  settings: z.object({
    baseUrl: z.string().trim().max(500).refine(v => { if (!v) return true; try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }, '请输入有效的 HTTP(S) API 基础地址，不含查询参数或账号密码'),
    model: z.string().trim().max(200), apiKey: z.string().max(2000).optional(), clearKey: z.boolean().optional(),
  }).refine(v => Boolean(v.baseUrl) === Boolean(v.model), '服务地址与模型名称需要同时填写或清空'),
};
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw Object.assign(new Error(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；')), { status: 400 });
  return result.data;
}
