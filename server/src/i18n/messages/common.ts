const zh = {
  invalidParams: '参数错误',
  mailServerFailed: (reason: string) => `邮箱服务器操作失败：${reason}`,
  apiKeyMissingScope: (scope: string) => `API Key 缺少 ${scope} 权限`,
  missingScope: (scope: string) => `缺少 ${scope} 权限`,
  auth: {
    passwordMin: '密码至少 8 位',
    currentPasswordRequired: '请输入当前密码',
    usernameRequired: '用户名不能为空',
    newPasswordMin: '新密码至少 8 位',
    alreadySetup: '已完成初始化',
    tooManyAttempts: '尝试次数过多，请 10 分钟后再试',
    wrongCredentials: '用户名或密码错误',
    wrongCurrentPassword: '当前密码不正确',
    usernameTaken: '用户名已被使用',
    unsupportedLocale: '不支持的语言',
  },
};

const en: typeof zh = {
  invalidParams: 'Invalid parameters',
  mailServerFailed: (reason: string) => `Mail server operation failed: ${reason}`,
  apiKeyMissingScope: (scope: string) => `This API key lacks the ${scope} permission`,
  missingScope: (scope: string) => `Missing ${scope} permission`,
  auth: {
    passwordMin: 'Password must be at least 8 characters',
    currentPasswordRequired: 'Enter your current password',
    usernameRequired: 'Username cannot be empty',
    newPasswordMin: 'New password must be at least 8 characters',
    alreadySetup: 'Setup has already been completed',
    tooManyAttempts: 'Too many attempts. Try again in 10 minutes',
    wrongCredentials: 'Incorrect username or password',
    wrongCurrentPassword: 'Current password is incorrect',
    usernameTaken: 'That username is already taken',
    unsupportedLocale: 'Unsupported language',
  },
};

export default { zh, en };
