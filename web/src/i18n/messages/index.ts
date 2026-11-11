import about from './about';
import accountForm from './accountForm';
import accounts from './accounts';
import aiSettings from './aiSettings';
import aiUsage from './aiUsage';
import analysis from './analysis';
import appearance from './appearance';
import languagePage from './languagePage';
import assistant from './assistant';
import audit from './audit';
import auth from './auth';
import channels from './channels';
import common from './common';
import compose from './compose';
import dashboard from './dashboard';
import editor from './editor';
import followUp from './followUp';
import insight from './insight';
import labels from './labels';
import layout from './layout';
import mail from './mail';
import mcpOAuth from './mcpOAuth';
import oauthApps from './oauthApps';
import openApi from './openApi';
import outbox from './outbox';
import overview from './overview';
import people from './people';
import prompts from './prompts';
import proxies from './proxies';
import reader from './reader';
import reports from './reports';
import rules from './rules';
import threads from './threads';
import unsubscribe from './unsubscribe';

// 每个文件导出同一结构的 { zh, en }，英文按中文的类型检查，漏翻或参数不一致会编译失败
const NAMESPACES = {
  about,
  accountForm,
  accounts,
  aiSettings,
  aiUsage,
  analysis,
  appearance,
  assistant,
  audit,
  auth,
  channels,
  common,
  compose,
  dashboard,
  editor,
  followUp,
  insight,
  labels,
  languagePage,
  layout,
  mail,
  mcpOAuth,
  oauthApps,
  openApi,
  outbox,
  overview,
  people,
  prompts,
  proxies,
  reader,
  reports,
  rules,
  threads,
  unsubscribe,
};

type Namespaces = typeof NAMESPACES;
export type Messages = { [K in keyof Namespaces]: Namespaces[K]['zh'] };

const pick = (lang: 'zh' | 'en') => Object.fromEntries(Object.entries(NAMESPACES).map(([k, v]) => [k, v[lang]])) as Messages;

export const MESSAGES: Record<import('../index').Locale, Messages> = { 'zh-CN': pick('zh'), en: pick('en') };
