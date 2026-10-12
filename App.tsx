import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { DataProvider } from './context/DataContext';
import ProtectedRoute from './components/shared/ProtectedRoute';
import TalleristaLayout from './components/layout/TalleristaLayout';
import Login from './components/Login';
import ResetPassword from './components/ResetPassword';
import { ThemeProvider } from './components/shared/ThemeProvider';

// Tallerista Pages
import DashboardPage from './pages/DashboardPage';
import CalendarPage from './pages/CalendarPage';
import StudentsPage from './pages/StudentsPage';
import TeachersPage from './pages/TeachersPage';
import PiecesPage from './pages/PiecesPage';
import GiftCardsPage from './pages/GiftCardsPage';
import HistoryPage from './pages/HistoryPage';
import InventoryPage from './pages/InventoryPage';
import SettingsPage from './pages/SettingsPage';
import TeamPage from './pages/TeamPage';
import AgendaPage from './pages/AgendaPage';

// Admin Module (self-contained with its own context + original UI)
import AdminApp from './admin/AdminApp';

// Root route handler - redirects based on role
const RootRedirect: React.FC = () => {
  const { session, profile, loading } = useAuth();

  if (loading) {
      return (
      <div className="min-h-screen bg-neutral-base flex items-center justify-center">
        <div className="text-neutral-textHelper text-sm uppercase tracking-widest animate-pulse">
          Cargando...
        </div>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (profile?.role === 'super_admin') {
    return <Navigate to="/admin" replace />;
  }

  return <Navigate to="/dashboard" replace />;
};

/**
 * Wrapper that provides DataProvider + TalleristaLayout ONCE for ALL tallerista routes.
 * This prevents data reload on every navigation between tallerista pages.
 */
const TalleristaShell: React.FC = () => (
  <ProtectedRoute allowedRoles={['tallerista', 'staff']}>
    <DataProvider>
      <TalleristaLayout>
        <Outlet />
      </TalleristaLayout>
    </DataProvider>
  </ProtectedRoute>
);

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
          {/* Public Route */}
          <Route path="/login" element={<Login />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          {/* Root redirect */}
          <Route path="/" element={<RootRedirect />} />

          {/* Tallerista Routes — Single DataProvider + Layout shared across all pages */}
          <Route element={<TalleristaShell />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/agenda" element={<AgendaPage />} />
            <Route path="/students" element={<StudentsPage />} />
            <Route path="/teachers" element={<TeachersPage />} />
            <Route path="/pieces" element={<PiecesPage />} />
            <Route path="/giftcards" element={<GiftCardsPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/settings" element={<ProtectedRoute allowedRoles={['tallerista']}><SettingsPage /></ProtectedRoute>} />
            <Route path="/team" element={<ProtectedRoute allowedRoles={['tallerista']}><TeamPage /></ProtectedRoute>} />
          </Route>

          {/* Admin Routes - Self-contained module with original UI */}
          <Route path="/admin/*" element={
            <ProtectedRoute allowedRoles={['super_admin']}>
              <AdminApp />
            </ProtectedRoute>
          } />

          {/* Catch all */}
          <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
};

export default App;
