import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import './index.css';
import AuthPage from './pages/Auth';
import LoginPage from './pages/auth/login';
import SignupPage from './pages/auth/signup';
import LogoutPage from './pages/auth/logout';
import PrivacyPolicy from './pages/privacy';
import TermsOfService from './pages/terms';
import AuditPage from './pages/dashboard/settings/audit';
import Overview from './pages/dashboard/overview';
import Agent from './pages/dashboard/agent';
import Actions from './pages/dashboard/actions';
import Alerts from './pages/dashboard/alerts';
import DiscrepanciesPage from './pages/dashboard/discrepancies';
import RecommendationsPage from './pages/dashboard/recommendations';
import SettingsLayout from './pages/dashboard/settings';
import ApiKeysSettings from './pages/dashboard/settings/api-keys';
import AgentsSettings from './pages/dashboard/settings/agents';
import ActionsSettings from './pages/dashboard/settings/actions';
import ImportSettings from './pages/dashboard/settings/import';
import LandingPage from './pages/LandingPage';
import DocsPage from './pages/DocsPage';
import ProtectedRoute from './components/ProtectedRoute';
import NavBar from './components/NavBar';
import { ToastContainer, ToastContext } from './components/Toast';
import { useToast } from './hooks/useToast';

function DashboardLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <NavBar />
      <main className="max-w-[1400px] mx-auto px-6 py-8">{children}</main>
    </div>
  );
}

function DashboardShell(): React.ReactElement {
  return (
    <ProtectedRoute>
      <DashboardLayout>
        <Outlet />
      </DashboardLayout>
    </ProtectedRoute>
  );
}

function App(): React.ReactElement {
  const { toasts, showToast, dismissToast } = useToast();

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      <BrowserRouter>
        <Routes>
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/logout" element={<LogoutPage />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/terms" element={<TermsOfService />} />
          <Route path="/" element={<LandingPage />} />
          <Route path="/docs" element={<DocsPage />} />

          <Route path="/dashboard" element={<DashboardShell />}>
            <Route index element={<Overview />} />
            <Route path="agent" element={<Agent />} />
            <Route path="actions" element={<Actions />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="signals" element={<Navigate to="/dashboard" replace />} />
            <Route path="contracts" element={<Navigate to="/dashboard" replace />} />
            <Route path="discrepancies" element={<DiscrepanciesPage />} />
            <Route path="recommendations" element={<RecommendationsPage />} />
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="/dashboard/settings/api-keys" replace />} />
              <Route path="api-keys" element={<ApiKeysSettings />} />
              <Route path="agents" element={<AgentsSettings />} />
              <Route path="actions" element={<ActionsSettings />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="import" element={<ImportSettings />} />
            </Route>
          </Route>

          <Route path="/outcomes" element={<Navigate to="/dashboard" replace />} />
          <Route path="/trust" element={<Navigate to="/dashboard/agent" replace />} />
          <Route path="/alerts" element={<Navigate to="/dashboard/alerts" replace />} />
          <Route path="/audit" element={<Navigate to="/dashboard" replace />} />

          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
