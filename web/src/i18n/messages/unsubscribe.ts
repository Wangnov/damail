const zh = {
  methods: {
    'one-click': { label: '一键退订', hint: '按 RFC 8058 直接向发件人发送退订请求，不打开对方网页' },
    mailto: { label: '退订邮件', hint: '用收到邮件的邮箱发一封退订邮件，发出前可以在「草稿与待发」里撤销' },
    link: { label: '退订网页', hint: '发件人只提供了退订网页，需要在网页上自己完成退订' },
  },
  // 邮件头里没有退订方式，从正文里找到的退订链接
  bodyLink: { label: '正文链接', hint: '发件人没有按标准提供退订方式，这是从邮件正文里找到的退订链接，需要在网页上自己完成退订' },
  willOpen: (host: string) => `将打开 ${host}`,
  confirmTitle: (sender: string) => `退订 ${sender}？`,
  period: '。',
  openPage: '打开退订网页',
  unsubscribe: '退订',
  status: {
    done: { text: '已退订', hint: '' },
    unconfirmed: { text: '已请求退订', hint: '对方没有及时响应，退订可能已经生效' },
    opened: { text: '已打开退订网页', hint: '是否退订成功以网页上的结果为准' },
  } as Record<string, { text: string; hint: string }>,
  hintSep: '，',
  // AI 搜索
  aiThinking: 'AI 正在理解你的描述并筛选邮件…',
  aiNeedsSetup: 'AI 搜索需要先启用 AI 分析',
  goSetup: '去设置',
  plainSearch: '改用普通搜索',
  picked: (candidates: number, n: number) => `从 ${candidates} 封候选中挑出 ${n} 封`,
  relaxedKeywords: '，按条件没找到足够的邮件，已去掉关键词限制',
  relaxedFilters: '，按条件没找到足够的邮件，已去掉过滤条件',
  noResults: '没有找到符合描述的邮件',
  unknown: '（未知）',
  noSubject: '（无主题）',
};

const en: typeof zh = {
  methods: {
    'one-click': { label: 'One-click unsubscribe', hint: 'Sends an RFC 8058 unsubscribe request straight to the sender without opening their website' },
    mailto: { label: 'Unsubscribe by email', hint: 'Sends an unsubscribe email from the receiving account. You can undo it from Drafts before it goes out' },
    link: { label: 'Unsubscribe page', hint: 'The sender only offers an unsubscribe page, so you need to finish on their website' },
  },
  bodyLink: {
    label: 'Link in email',
    hint: "The sender doesn't offer a standard unsubscribe option. This is the unsubscribe link found in the email body, so you need to finish on their website",
  },
  willOpen: (host: string) => `Opens ${host}`,
  confirmTitle: (sender: string) => `Unsubscribe from ${sender}?`,
  period: '.',
  openPage: 'Open unsubscribe page',
  unsubscribe: 'Unsubscribe',
  status: {
    done: { text: 'Unsubscribed', hint: '' },
    unconfirmed: { text: 'Unsubscribe requested', hint: "The sender didn't respond in time; it may still have worked" },
    opened: { text: 'Unsubscribe page opened', hint: 'Whether it worked depends on what the page said' },
  },
  hintSep: ', ',
  aiThinking: 'AI is reading your description and filtering mail…',
  aiNeedsSetup: 'AI search needs AI analysis to be enabled first',
  goSetup: 'Set up',
  plainSearch: 'Use normal search instead',
  picked: (candidates: number, n: number) => `Picked ${n} of ${candidates} candidates`,
  relaxedKeywords: '. Not enough matches, so the keyword limits were dropped',
  relaxedFilters: '. Not enough matches, so the filters were dropped',
  noResults: 'No mail matches the description',
  unknown: '(unknown)',
  noSubject: '(no subject)',
};

export default { zh, en };
