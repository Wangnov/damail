/**
 * 系统内置的邮件分类（只读）。启动时同步到 categories 表，界面和 AI 都从表里读；
 * 这里是默认内容和兜底：表里没有时用这里的。邮件分析结果里存的是 key。
 * 加新语言：每个分类补一份对应语言的 name / description。
 */
import type { I18n } from '../i18n/context.js';

export type CategoryText = { name: string; description: string };
export type BuiltinCategory = { key: string; color: string; i18n: I18n<CategoryText> };

export const CATEGORIES = ['important', 'work', 'personal', 'finance', 'verification', 'shipping', 'notification', 'social', 'marketing', 'spam'] as const;
export type CategoryKey = (typeof CATEGORIES)[number];

export const BUILTIN_CATEGORIES: BuiltinCategory[] = [
  {
    key: 'important',
    color: 'red',
    i18n: {
      'zh-CN': { name: '重要', description: '需要用户亲自关注的关键邮件（合同、面试、法律、账户安全告警、紧急事务）' },
      en: {
        name: 'Important',
        description: 'Key mail the user must look at personally (contracts, interviews, legal matters, account security alerts, urgent issues)',
      },
    },
  },
  {
    key: 'work',
    color: 'blue',
    i18n: {
      'zh-CN': { name: '工作', description: '工作往来、同事 / 客户邮件、项目协作' },
      en: { name: 'Work', description: 'Work correspondence, mail from colleagues or clients, project collaboration' },
    },
  },
  {
    key: 'personal',
    color: 'green',
    i18n: {
      'zh-CN': { name: '个人', description: '亲友等私人往来' },
      en: { name: 'Personal', description: 'Private correspondence with family and friends' },
    },
  },
  {
    key: 'finance',
    color: 'gold',
    i18n: {
      'zh-CN': { name: '账单财务', description: '账单、发票、付款、扣费、银行 / 信用卡通知' },
      en: { name: 'Bills & finance', description: 'Bills, invoices, payments, charges, bank and credit card notices' },
    },
  },
  {
    key: 'verification',
    color: 'purple',
    i18n: {
      'zh-CN': { name: '验证码', description: '验证码、登录确认、一次性链接' },
      en: { name: 'Verification', description: 'Verification codes, sign-in confirmations, one-time links' },
    },
  },
  {
    key: 'shipping',
    color: 'cyan',
    i18n: {
      'zh-CN': { name: '物流', description: '订单发货、快递物流' },
      en: { name: 'Shipping', description: 'Order shipments and parcel tracking' },
    },
  },
  {
    key: 'notification',
    color: 'default',
    i18n: {
      'zh-CN': { name: '系统通知', description: '系统 / 平台自动通知（GitHub、云服务、App 提醒等）' },
      en: { name: 'Notifications', description: 'Automated system or platform notices (GitHub, cloud services, app reminders, etc.)' },
    },
  },
  {
    key: 'social',
    color: 'geekblue',
    i18n: {
      'zh-CN': { name: '社交', description: '社交平台消息与动态' },
      en: { name: 'Social', description: 'Messages and updates from social platforms' },
    },
  },
  {
    key: 'marketing',
    color: 'default',
    i18n: {
      'zh-CN': { name: '营销推广', description: '营销推广、广告、newsletter' },
      en: { name: 'Marketing', description: 'Promotions, ads and newsletters' },
    },
  },
  {
    key: 'spam',
    color: 'default',
    i18n: {
      'zh-CN': { name: '垃圾', description: '诈骗、钓鱼、明显垃圾' },
      en: { name: 'Spam', description: 'Scams, phishing and obvious junk' },
    },
  },
];
