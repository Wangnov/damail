import { useQuery } from '@tanstack/react-query';
import { Flex, Spin } from 'antd';
import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { api, type CurrentUser } from './api';
import { getLocale, isLocale, setLocale } from './i18n';
import { AppLayout } from './components/AppLayout';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { MailPage } from './pages/MailPage';
import { OAuthResultPage } from './pages/OAuthResultPage';
import { OutboxPage } from './pages/OutboxPage';
import { OverviewPage } from './pages/OverviewPage';
import { ReportsPage } from './pages/ReportsPage';
import { ContactsPage } from './pages/ContactsPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { AboutPage } from './pages/settings/AboutPage';
import { ChangelogPage } from './pages/settings/ChangelogPage';
import { AccountsPage } from './pages/settings/AccountsPage';
import { AppearancePage } from './pages/settings/AppearancePage';
import { LanguagePage } from './pages/settings/LanguagePage';
import { OAuthAppsPage } from './pages/settings/OAuthAppsPage';
import { ProxiesPage } from './pages/settings/ProxiesPage';
import { ApiKeysPage } from './pages/settings/ApiKeysPage';
import { McpConnectPage } from './pages/settings/McpConnectPage';
import { McpAuthorizationsPage, McpOAuthSettingsPage } from './pages/settings/McpOAuthPages';
import { AuditLogsPage } from './pages/settings/AuditLogsPage';
import { AiSettingsPage } from './pages/ai/AiSettingsPage';
import { AiRequestsPage, AiStatsPage } from './pages/ai/AiUsage';
import { AnalysisPage } from './pages/ai/AnalysisPage';
import { LabelsPage } from './pages/ai/LabelsPage';
import { PromptsPage } from './pages/ai/PromptsPage';
import { ChannelsPage } from './pages/ai/ChannelsPage';
import { RulesPage } from './pages/ai/RulesPage';

type AuthStatus = { needsSetup: boolean; user: CurrentUser | null };

export function App() {
  const status = useQuery({ queryKey: ['auth'], queryFn: () => api<AuthStatus>('/api/auth/status') });
  // 登录后以账号保存的语言为准（换了设备或在别处改过）
  const saved = status.data?.user?.locale;
  useEffect(() => {
    if (isLocale(saved) && saved !== getLocale()) setLocale(saved);
  }, [saved]);
  const { pathname } = useLocation();

  // 授权结果页不经过登录，「登录已过期」这类错误也要能看到
  if (pathname === '/oauth/result') return <OAuthResultPage />;

  if (status.isPending) {
    return (
      <Flex align="center" justify="center" style={{ height: '100%' }}>
        <Spin size="large" />
      </Flex>
    );
  }
  if (!status.data?.user) return <AuthPage mode={status.data?.needsSetup ? 'setup' : 'login'} />;

  return (
    <Routes>
      {/* AI 相关页面原来在设置下，旧地址（书签等）跳到新位置；放在布局外，免得侧栏把旧地址记成「设置」上次打开的页面 */}
      <Route path="/settings/ai" element={<Navigate to="/ai/models" replace />} />
      <Route path="/settings/analysis" element={<Navigate to="/ai/analysis" replace />} />
      <Route path="/settings/channels" element={<Navigate to="/ai/channels" replace />} />
      <Route path="/settings/rules" element={<Navigate to="/ai/rules" replace />} />
      <Route path="/settings/audit" element={<Navigate to="/audit" replace />} />
      <Route element={<AppLayout username={status.data.user.username} />}>
        <Route path="/" element={<OverviewPage username={status.data.user.username} />} />
        <Route path="/mail" element={<MailPage />} />
        <Route path="/outbox" element={<OutboxPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/subscriptions" element={<SubscriptionsPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/reports/:id" element={<ReportsPage />} />
        <Route path="/settings/appearance" element={<AppearancePage />} />
        <Route path="/settings/language" element={<LanguagePage />} />
        <Route path="/settings/accounts" element={<AccountsPage />} />
        <Route path="/settings/oauth" element={<OAuthAppsPage />} />
        <Route path="/settings/proxies" element={<ProxiesPage />} />
        <Route path="/settings/mcp" element={<McpConnectPage />} />
        <Route path="/settings/api" element={<ApiKeysPage />} />
        <Route path="/settings/mcp-oauth" element={<McpOAuthSettingsPage />} />
        <Route path="/settings/mcp-authorizations" element={<McpAuthorizationsPage />} />
        <Route path="/settings/about" element={<AboutPage />} />
        <Route path="/settings/changelog" element={<ChangelogPage />} />
        <Route path="/audit" element={<AuditLogsPage />} />
        <Route path="/ai/models" element={<AiSettingsPage />} />
        <Route path="/ai/analysis" element={<AnalysisPage />} />
        <Route path="/ai/labels" element={<LabelsPage />} />
        <Route path="/ai/prompts" element={<PromptsPage />} />
        <Route path="/ai/channels" element={<ChannelsPage />} />
        <Route path="/ai/rules" element={<RulesPage />} />
        <Route path="/ai/requests" element={<AiRequestsPage />} />
        <Route path="/ai/stats" element={<AiStatsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
