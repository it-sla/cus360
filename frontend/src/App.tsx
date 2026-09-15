import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';

// Layout Components
import EfferdDashboard2 from '@/components/ui/efferd-dashboard-2';
import { useAuth } from '@/auth';

// Pages
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/Login';
import SetPasswordPage from './pages/SetPassword';
import ExecutiveOverview from './pages/ExecutiveOverview';
import BusinessAnalytics from './pages/BusinessAnalytics';
import CustomerAnalytics from './pages/CustomerAnalytics';
import GeographyAnalytics from './pages/GeographyAnalytics';
import DocumentTypeAnalytics from './pages/DocumentTypeAnalytics';
import OperationalAnalytics from './pages/OperationalAnalytics';
import UniversalSearch from './pages/UniversalSearch';
import CustomerDirectory from './pages/CustomerDirectory';
import CustomerManagement from './pages/CustomerManagement';
import Customer360 from './pages/Customer360';
import AirWaybills from './pages/AirWaybills';
import MasterAirWaybills from './pages/MasterAirWaybills';
import CrmSync from './pages/CrmSync';
import MatchingReview from './pages/MatchingReview';
import DataQuality from './pages/DataQuality';
import ManifestImports from './pages/ManifestImports';
import AeAssignment from './pages/AeAssignment';
import AeTargets from './pages/AeTargets';
import Profitability from './pages/Profitability';
import Rankings from './pages/Rankings';
import Leaderboard from './pages/Leaderboard';
import Alerts from './pages/Alerts';
import Pipeline from './pages/Pipeline';
import Users from './pages/admin/Users';
import Roles from './pages/admin/Roles';
import AuditLogs from './pages/admin/AuditLogs';
import Settings from './pages/admin/Settings';
import AEPerformance from './pages/AEPerformance';

import { TooltipProvider } from '@/components/ui/tooltip';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center bg-black text-white">Loading access profile…</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

function RequireRole({ roles, children }: { roles: string[]; children: React.ReactNode }) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center bg-black text-white">Loading access profile…</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (user.role !== 'super_admin' && !roles.includes(user.role)) {
    return <Navigate to="/app" replace />;
  }

  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  return <RequireRole roles={['super_admin']}>{children}</RequireRole>;
}

export default function App() {
  return (
    <Router>
      <TooltipProvider>
        <Routes>
          {/* PUBLIC LANDING PAGE */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/set-password" element={<SetPasswordPage />} />

          {/* CRM APP SHELL */}
          <Route
            path="/app"
            element={(
              <RequireAuth>
                <EfferdDashboard2 />
              </RequireAuth>
            )}
          >
            {/* EXECUTIVE */}
            <Route index element={<ExecutiveOverview />} />
            <Route path="analytics" element={<BusinessAnalytics />} />
            <Route path="geography" element={<GeographyAnalytics />} />
            <Route path="doc-type" element={<DocumentTypeAnalytics />} />
            <Route path="operations" element={<OperationalAnalytics />} />
            <Route path="customer-analytics" element={<CustomerAnalytics />} />
            <Route path="ae-performance" element={<AEPerformance />} />
            <Route path="search" element={<UniversalSearch />} />

            {/* CUSTOMERS */}
            <Route path="customers" element={<CustomerDirectory />} />
            <Route path="customers/:id" element={<Customer360 />} />

            {/* OPERATIONS */}
            <Route path="awb" element={<AirWaybills />} />
            <Route path="mawb" element={<MasterAirWaybills />} />
            <Route path="imports" element={<ManifestImports />} />

            {/* INTELLIGENCE */}
            <Route path="profitability" element={(
              <RequireRole roles={['admin', 'sales_lead']}>
                <Profitability />
              </RequireRole>
            )} />
            <Route path="rankings" element={<Rankings />} />
            <Route path="leaderboard" element={<Leaderboard />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="pipeline" element={<Pipeline />} />

            {/* DATA GOVERNANCE */}
            <Route path="sync" element={(
              <RequireAdmin>
                <CrmSync />
              </RequireAdmin>
            )} />
            <Route path="matching" element={(
              <RequireAdmin>
                <MatchingReview />
              </RequireAdmin>
            )} />
            <Route path="quality" element={(
              <RequireAdmin>
                <DataQuality />
              </RequireAdmin>
            )} />
            <Route path="ae-assignment" element={(
              <RequireAdmin>
                <AeAssignment />
              </RequireAdmin>
            )} />
            <Route path="ae-targets" element={(
              <RequireAdmin>
                <AeTargets />
              </RequireAdmin>
            )} />

            {/* ADMINISTRATION */}
            <Route path="customer-management" element={(
              <RequireAdmin>
                <CustomerManagement />
              </RequireAdmin>
            )} />
            <Route path="users" element={(
              <RequireAdmin>
                <Users />
              </RequireAdmin>
            )} />
            <Route path="roles" element={(
              <RequireAdmin>
                <Roles />
              </RequireAdmin>
            )} />
            <Route path="audit-logs" element={(
              <RequireAdmin>
                <AuditLogs />
              </RequireAdmin>
            )} />
            <Route path="settings" element={(
              <RequireAdmin>
                <Settings />
              </RequireAdmin>
            )} />
          </Route>

          {/* FALLBACK */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </TooltipProvider>
    </Router>
  );
}
