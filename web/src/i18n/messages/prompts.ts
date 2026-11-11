const zh = {
  title: '提示词',
  desc: '各项 AI 功能发给模型的系统提示词。系统内置，只能查看；按发起请求时的界面语言选用对应语言的版本，缺这种语言时用英文。',
  name: '名称',
  purpose: '用途',
  description: '说明',
  vars: '变量',
  updatedAt: '更新时间',
  view: '查看',
  varsHelp: '{{变量}} 会在调用时替换成实际内容',
  noVars: '没有变量',
  readonly: '系统内置，只读',
  empty: '没有提示词',
};

const en: typeof zh = {
  title: 'Prompts',
  desc: 'The system prompts each AI feature sends to the model. They are built in and read-only. The version in the interface language at the time of the request is used, falling back to English.',
  name: 'Name',
  purpose: 'Purpose',
  description: 'Description',
  vars: 'Variables',
  updatedAt: 'Updated',
  view: 'View',
  varsHelp: '{{variables}} are replaced with real content at call time',
  noVars: 'No variables',
  readonly: 'Built in, read-only',
  empty: 'No prompts',
};

export default { zh, en };
