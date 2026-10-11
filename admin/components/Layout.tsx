
import React, { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAppContext } from '../context/AppContext';
import { Toast, Icon, Button } from './UI';
import ThemeToggle from '../../components/shared/ThemeToggle';
import DiagonalPattern from '../../components/shared/DiagonalPattern';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { toast, currentUser, logout, workshops, globalMetrics, showToast } = useAppContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const getTitle = () => {
    const path = location.pathname;
    if (path === '/admin' || path === '/admin/') return 'Panel de control';
    if (path.startsWith('/admin/talleres')) return 'Talleres';
    if (path === '/admin/reportes') return 'Reportes';
    if (path === '/admin/equipo') return 'Equipo';
    return 'Admin';
  };

  const navItems = [
    { to: '/admin', label: 'Inicio', icon: <Icon.Home /> },
    { to: '/admin/talleres', label: 'Talleres', icon: <Icon.Workshop /> },
    { to: '/admin/reportes', label: 'Reportes', icon: <Icon.Chart /> },
    { to: '/admin/equipo', label: 'Equipo', icon: <Icon.IdCard /> },
  ];

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => {
      setIsRefreshing(false);
      showToast('Sincronización Exitosa', 'success');
    }, 1200);
  };

  const alertsCount =
    workshops.filter(w => !w.adminGeneralUserId).length +
    globalMetrics.unlinkedGiftCards +
    globalMetrics.missingExpiryGiftCards +
    globalMetrics.nullAudienceSessions;
  const displayName = currentUser?.nombre || (isLoggingOut ? 'Cerrando sesión' : 'Admin');
  const displayStatus = currentUser ? 'Activo' : (isLoggingOut ? 'Cerrando' : 'Sin sesión');

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-base lg:pl-[300px]">

      {/* Sidebar Desktop */}
      <aside className="hidden lg:flex fixed left-0 top-0 h-screen w-[300px] bg-white border-r border-neutral-border flex-col p-7 z-50 overflow-y-auto no-scrollbar">
        <div className="flex flex-col items-start mb-10 px-2">
          <div className="relative w-12 h-12 overflow-hidden bg-brand rounded-[15px] flex items-center justify-center font-bold text-xl text-white mb-4 cursor-pointer shadow-sm" onClick={() => navigate('/admin')}>
            <DiagonalPattern dark className="opacity-45" />
            <span className="relative z-10">B</span>
          </div>
          <span className="font-display text-[22px] font-bold tracking-tight text-neutral-textMain">Barro &amp; Co.</span>
          <span className="eyebrow mt-1">Red de talleres</span>
          <div className="accent-line mt-3"></div>
        </div>

        <nav className="menu-typography-110 space-y-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/admin'}
              className={({ isActive }) => `flex items-center gap-3 px-3.5 min-h-[44px] rounded-[10px] transition-colors duration-200 font-medium text-[14px] ${isActive ? 'bg-brand text-white' : 'text-neutral-textSec hover:text-brand hover:bg-neutral-alt'}`}
            >
              {({ isActive }) => (
                <>
                  <span className={isActive ? '' : 'opacity-50'}>{item.icon}</span>
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Sección Inferior del Sidebar */}
        <div className="mt-auto pt-8 flex flex-col gap-4">
          <Button
            variant="primary"
            size="md"
            className="w-full"
            onClick={() => navigate('/admin/talleres/nuevo')}
          >
            Nueva sede
            <Icon.ArrowUpRight />
          </Button>

          <div className="p-4 bg-neutral-sec rounded-2xl flex items-center gap-3 border border-neutral-border">
            <div className="w-10 h-10 rounded-full border-2 border-white overflow-hidden shadow-sm shrink-0 bg-white">
              <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${displayName}`} alt="Admin" />
            </div>
            <div className="overflow-hidden">
              <p className="text-[13px] font-semibold truncate text-neutral-textMain leading-tight mb-0.5">{displayName}</p>
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${currentUser ? 'bg-emerald-500' : 'bg-amber-500'}`}></div>
                <p className={`text-[12px] font-medium ${currentUser ? 'text-emerald-600' : 'text-amber-600'}`}>{displayStatus}</p>
              </div>
            </div>
          </div>

          <button
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="w-full flex items-center gap-3 px-3.5 min-h-[44px] rounded-[10px] text-[14px] font-medium text-neutral-textHelper hover:text-brand hover:bg-neutral-alt transition-colors group disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <span className="opacity-40 group-hover:opacity-100 transition-opacity rotate-180"><Icon.Logout /></span>
            {isLoggingOut ? 'Desconectando…' : 'Desconectar'}
          </button>
        </div>
      </aside>

      {/* TopBar */}
      <header className="fixed top-0 left-0 lg:left-[300px] right-0 h-16 lg:h-20 bg-neutral-base/90 backdrop-blur-xl z-40 px-4 md:px-6 lg:px-12 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setIsMenuOpen(true)}
            aria-label="Abrir menú"
            className="lg:hidden w-11 h-11 -ml-2 flex flex-col justify-center items-start gap-[5px] shrink-0 hover:opacity-60 transition-opacity"
          >
            <div className="w-5 h-[2px] bg-neutral-textMain rounded-full"></div>
            <div className="w-5 h-[2px] bg-neutral-textMain rounded-full"></div>
            <div className="w-3.5 h-[2px] bg-neutral-textMain rounded-full"></div>
          </button>
          <h1 className="ui-section-title text-neutral-textMain truncate">{getTitle()}</h1>
        </div>

        <div className="flex items-center gap-3 md:gap-5">
          <button
            onClick={handleRefresh}
            aria-label="Sincronizar"
            className={`w-11 h-11 flex items-center justify-center text-neutral-textHelper hover:text-brand transition-all ${isRefreshing ? 'animate-spin text-brand' : ''}`}
          >
            <Icon.Refresh />
          </button>
          <ThemeToggle compact />
          <button aria-label="Alertas" className="w-11 h-11 flex items-center justify-center text-neutral-textHelper hover:text-brand transition-all relative">
            <Icon.Bell />
            {alertsCount > 0 && (
              <span className="absolute top-2 right-2 w-4 h-4 bg-brand border-2 border-neutral-base rounded-full flex items-center justify-center text-[11px] text-white font-semibold">
                {alertsCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Menú Móvil */}
      {isMenuOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/35 backdrop-blur-sm z-[100] animate-fade-in lg:hidden"
            onClick={() => setIsMenuOpen(false)}
          />
          <div className="fixed top-0 left-0 h-full w-[min(320px,88vw)] bg-white z-[110] shadow-2xl flex flex-col overflow-hidden rounded-r-3xl lg:hidden animate-fade-in">
            <div className="px-5 py-5 border-b border-neutral-border flex justify-between items-start gap-4">
              <div>
                <span className="font-display text-[20px] font-bold text-neutral-textMain">Barro &amp; Co.</span>
                <p className="text-[12px] text-neutral-textHelper uppercase tracking-[0.14em] font-medium mt-0.5">Panel de administración</p>
              </div>
              <ThemeToggle compact />
              <button onClick={() => setIsMenuOpen(false)} aria-label="Cerrar menú" className="w-10 h-10 -mr-2 rounded-full text-neutral-textMain hover:bg-neutral-sec flex items-center justify-center transition-colors">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>

            <nav className="menu-typography-110 flex-1 overflow-y-auto no-scrollbar p-4 space-y-1">
              {navItems.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/admin'}
                  onClick={() => setIsMenuOpen(false)}
                  className={({ isActive }) => `flex items-center gap-3 px-4 min-h-[44px] rounded-[10px] transition-colors duration-200 font-medium text-[15px] ${isActive ? 'bg-brand text-white' : 'text-neutral-textMain hover:bg-neutral-alt'}`}
                >
                  {({ isActive }) => (
                    <>
                      <span className={isActive ? '' : 'opacity-50'}>{item.icon}</span>
                      {item.label}
                    </>
                  )}
                </NavLink>
              ))}
            </nav>

            <div className="p-4 border-t border-neutral-border flex flex-col gap-3">
              <Button
                variant="primary"
                size="md"
                className="w-full"
                onClick={() => { setIsMenuOpen(false); navigate('/admin/talleres/nuevo'); }}
              >
                Nueva sede
                <Icon.ArrowUpRight />
              </Button>
              <button
                onClick={handleLogout}
                disabled={isLoggingOut}
                className="w-full flex items-center gap-3 px-4 min-h-[44px] rounded-[10px] text-[14px] font-medium text-neutral-textHelper hover:text-brand hover:bg-neutral-alt transition-colors disabled:opacity-60"
              >
                <span className="rotate-180"><Icon.Logout /></span>
                {isLoggingOut ? 'Desconectando…' : 'Desconectar'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Main Content */}
      <main className="pt-20 lg:pt-28 px-4 md:px-6 lg:px-8 xl:px-12 pb-24 lg:pb-20">
        {children}
      </main>

      {toast && <Toast message={toast.message} type={toast.type} />}
    </div>
  );
};
