import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
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
import Simulate from './pages/dashboard/simulate';
import SignalsPage from './pages/dashboard/signals';
import ContractsPage from './pages/dashboard/contracts';
import DiscrepanciesPage from './pages/dashboard/discrepancies';
import SettingsLayout from './pages/dashboard/settings';
import ApiKeysSettings from './pages/dashboard/settings/api-keys';
import AgentsSettings from './pages/dashboard/settings/agents';
import ActionsSettings from './pages/dashboard/settings/actions';
import ProtectedRoute from './components/ProtectedRoute';
import NavBar from './components/NavBar';
import { ToastContainer, ToastContext } from './components/Toast';
import { useToast } from './hooks/useToast';

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}

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
          <Route path="/" element={<Navigate to="/auth" replace />} />

          <Route path="/dashboard" element={<DashboardShell />}>
            <Route index element={<Overview />} />
            <Route path="agent" element={<Agent />} />
            <Route path="actions" element={<Actions />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="simulate" element={<Simulate />} />
            <Route path="signals" element={<SignalsPage />} />
            <Route path="contracts" element={<ContractsPage />} />
            <Route path="discrepancies" element={<DiscrepanciesPage />} />
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="/dashboard/settings/api-keys" replace />} />
              <Route path="api-keys" element={<ApiKeysSettings />} />
              <Route path="agents" element={<AgentsSettings />} />
              <Route path="actions" element={<ActionsSettings />} />
              <Route path="audit" element={<AuditPage />} />
            </Route>
          </Route>

          <Route path="/outcomes" element={<Navigate to="/dashboard" replace />} />
          <Route path="/trust" element={<Navigate to="/dashboard/agent" replace />} />
          <Route path="/alerts" element={<Navigate to="/dashboard/alerts" replace />} />
          <Route path="/simulate" element={<Navigate to="/dashboard/simulate" replace />} />
          <Route path="/audit" element={<Navigate to="/dashboard" replace />} />

          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

function ErrorFallback(): React.ReactElement {
  return (
    <div
      style={{
        padding: '2rem',
        color: '#f0f4ff',
        background: '#080b12',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: '1rem',
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Something went wrong</h1>
      <p style={{ color: '#888888', fontSize: '0.9rem' }}>The error has been reported. Try refreshing the page.</p>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: '#00FF85',
          color: '#000000',
          border: 'none',
          padding: '0.6rem 1.5rem',
          borderRadius: '6px',
          fontWeight: 600,
          cursor: 'pointer',
          marginTop: '1rem',
        }}
      >
        Refresh
      </button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
