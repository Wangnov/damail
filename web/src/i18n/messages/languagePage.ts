const zh = {
  title: '语言设置',
  description: '选了立即生效，保存在账号里，换设备登录也是这个语言。',
  hints: { 'zh-CN': '界面和 AI 输出都用简体中文', en: 'Interface and AI output in English' } as Record<import('../index').Locale, string>,
  scope: '界面文字、服务端提示、AI 生成的摘要和日报、MCP 工具说明都会跟着切换；已经生成的内容不会重新翻译。',
};

const en: typeof zh = {
  title: 'Language',
  description: 'Applies right away and is saved to your account, so other devices use it too.',
  hints: { 'zh-CN': '界面和 AI 输出都用简体中文', en: 'Interface and AI output in English' },
  scope:
    "Interface text, server messages, AI summaries and reports, and MCP tool descriptions all follow this setting. Content that's already been generated isn't re-translated.",
};

export default { zh, en };
