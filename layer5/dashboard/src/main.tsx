import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import AuthPage from './pages/Auth';
import LoginPage from './pages/auth/login';
import SignupPage from './pages/auth/signup';
import LogoutPage from './pages/auth/logout';
import PrivacyPolicy from './pages/privacy';
import TermsOfService from './pages/terms';
import ApiKeysPage from './pages/settings/api-keys';
import AuditTrail from './pages/audit';
import Overview from './pages/dashboard/overview';
import Agent from './pages/dashboard/agent';
import Actions from './pages/dashboard/actions';
import Alerts from './pages/dashboard/alerts';
import Simulate from './pages/dashboard/simulate';
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

          <Route
            path="/dashboard"
            element={(
              <ProtectedRoute>
                <DashboardLayout>
                  <Overview />
                </DashboardLayout>
              </ProtectedRoute>
            )}
          />
          <Route
            path="/dashboard/agent"
            element={(
              <ProtectedRoute>
                <DashboardLayout>
                  <Agent />
                </DashboardLayout>
              </ProtectedRoute>
            )}
          />
          <Route
            path="/dashboard/actions"
            element={(
              <ProtectedRoute>
                <DashboardLayout>
                  <Actions />
                </DashboardLayout>
              </ProtectedRoute>
            )}
          />
          <Route
            path="/dashboard/alerts"
            element={(
              <ProtectedRoute>
                <DashboardLayout>
                  <Alerts />
                </DashboardLayout>
              </ProtectedRoute>
            )}
          />
          <Route
            path="/dashboard/simulate"
            element={(
              <ProtectedRoute>
                <DashboardLayout>
                  <Simulate />
                </DashboardLayout>
              </ProtectedRoute>
            )}
          />
          <Route
            path="/dashboard/settings/api-keys"
            element={(
              <ProtectedRoute>
                <DashboardLayout>
                  <ApiKeysPage />
                </DashboardLayout>
              </ProtectedRoute>
            )}
          />
          <Route
            path="/dashboard/settings/audit"
            element={(
              <ProtectedRoute>
                <DashboardLayout>
                  <AuditTrail />
                </DashboardLayout>
              </ProtectedRoute>
            )}
          />

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
