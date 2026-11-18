import MfaGate from './MfaGate';
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth, UserRole } from '../../context/AuthContext';

interface ProtectedRouteProps {
    children: React.ReactNode;
    allowedRoles?: UserRole[];
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, allowedRoles }) => {
    const { session, profile, loading, error, logout } = useAuth();
    const location = useLocation();

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-neutral-base" role="status" aria-live="polite">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-brand/20 border-t-brand rounded-full animate-spin"></div>
                    <p className="text-[12px] text-neutral-textHelper uppercase tracking-widest font-light">
                        Verificando acceso...
                    </p>
                </div>
            </div>
        );
    }

    // No session → redirect to login
    if (!session) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    // Session exists but profile hasn't loaded → show loading spinner
    // DO NOT redirect to login here — it causes an infinite loop for staff users
    // whose sedeId takes an extra render cycle to resolve
    if (!profile) {
        if (error) {
            return (
                <div className="min-h-screen flex items-center justify-center bg-neutral-base p-6">
                    <div className="max-w-md rounded-2xl border border-red-200 bg-white p-6 text-center" role="alert">
                        <h1 className="text-lg font-semibold text-neutral-textMain">No se pudo cargar tu perfil</h1>
                        <p className="mt-2 text-sm text-neutral-textHelper">{error}</p>
                        <button type="button" onClick={logout} className="mt-5 min-h-[44px] rounded-[10px] bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-hover">
                            Volver al inicio de sesión
                        </button>
                    </div>
                </div>
            );
        }
        return (
            <div className="min-h-screen flex items-center justify-center bg-neutral-base" role="status" aria-live="polite">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-brand/20 border-t-brand rounded-full animate-spin"></div>
                    <p className="text-[12px] text-neutral-textHelper uppercase tracking-widest font-light">
                        Cargando perfil...
                    </p>
                </div>
            </div>
        );
    }

    // Check role permissions
    if (allowedRoles && !allowedRoles.includes(profile.role)) {
        if (profile.role === 'super_admin') {
            return <Navigate to="/admin" replace />;
        }
        return <Navigate to="/dashboard" replace />;
    }

    if (profile.role === 'super_admin' || profile.role === 'tallerista') return <MfaGate key={session.user.id} userId={session.user.id} onLogout={logout}>{children}</MfaGate>;
    return <>{children}</>;
};

export default ProtectedRoute;
