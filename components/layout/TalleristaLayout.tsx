import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useData } from '../../context/DataContext';
import { logoutAndRedirect } from '../../utils/logout';
import { capitalizeEs, formatDate } from '../../utils/dateFormat';
import { presentDisplayName } from '../../utils/displayName';
import ThemeToggle from '../shared/ThemeToggle';
import DiagonalPattern from '../shared/DiagonalPattern';

interface TalleristaLayoutProps {
    children: React.ReactNode;
}

const navItems = [
    {
        path: '/dashboard', label: 'Resumen', section: 'Inicio', icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
        )
    },
    {
        path: '/calendar', label: 'Clases', section: 'Gestión', icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
        )
    },
    {
        path: '/agenda', label: 'Otras actividades del taller', section: 'Gestión', icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6 3v3m12-3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1Zm3 8h3m-3 4h3m3-4h3m-3 4h3" /></svg>
        )
    },
    {
        path: '/students', label: 'Alumnos', section: 'Gestión', icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
        )
    },
    {
        path: '/history', label: 'Historial', section: 'Gestión', icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        )
    },
    {
        path: '/giftcards', label: 'Bonos regalo', section: 'Comercial', icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" /></svg>
        )
    },
    {
        path: '/inventory', label: 'Inventario', section: 'Taller', icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
        )
    },
    {
        path: '/pieces', label: 'Piezas', section: 'Taller', icon: (
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M5 9h14l-2 11H7L5 9ZM8 9V4h8v5" strokeWidth="2" /></svg>
        )
    },
    {
        path: '/team', label: 'Equipo de trabajo', section: 'Equipo de trabajo', icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
        )
    },
    {
        path: '/teachers', label: 'Profesores', section: 'Equipo de trabajo', icon: (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 6l7 4-7 4-7-4 7-4zm0 8v6m-7-2l7 4 7-4" /></svg>
        )
    },
];

const mobilePrimaryPaths = ['/dashboard', '/calendar', '/students', '/giftcards', '/agenda'];
const mobilePrimaryLabels: Record<string, string> = {
    '/dashboard': 'Resumen',
    '/calendar': 'Clases',
    '/students': 'Alumnos',
    '/giftcards': 'Bonos regalo',
    '/agenda': 'Otras actividades del taller'
};

const menuConfig = [
    { group: 'Inicio', items: [{ path: '/dashboard', label: 'Resumen' }] },
    {
        group: 'Gestión', items: [
            { path: '/calendar', label: 'Clases' },
            { path: '/agenda', label: 'Otras actividades del taller' },
            { path: '/students', label: 'Alumnos' },
            { path: '/history', label: 'Historial' }
        ]
    },
    { group: 'Taller', items: [{ path: '/pieces', label: 'Piezas' }, { path: '/inventory', label: 'Inventario' }] },
    { group: 'Comercial', items: [{ path: '/giftcards', label: 'Bonos regalo' }] },
    { group: 'Equipo de trabajo', items: [{ path: '/team', label: 'Equipo de trabajo' }, { path: '/teachers', label: 'Profesores' }] },
    { group: 'Sistema', items: [{ path: '/settings', label: 'Administración del taller' }] }
];

const workshopTodayLabel = () => capitalizeEs(formatDate(new Date(), 'long'));

const getViewTitle = (pathname: string) => {
    switch (pathname) {
        case '/dashboard': return <>
            Resumen
            <span className="mt-1 block text-[13px] font-medium not-italic tracking-normal text-neutral-textHelper">
                {workshopTodayLabel()} · Estado del taller hoy
            </span>
        </>;
        case '/calendar': return <>Clases</>;
        case '/agenda': return <>Otras actividades del <span className="text-brand italic">taller</span></>;
        case '/students': return <>Alumnos</>;
        case '/teachers': return <>Profesores</>;
        case '/pieces': return <>Piezas</>;
        case '/giftcards': return <>Bonos <span className="text-brand italic">regalo</span></>;
        case '/history': return <>Historial</>;
        case '/inventory': return <>Inventario</>;
        case '/settings': return <>Administración del <span className="text-brand italic">taller</span></>;
        case '/team': return <>Equipo de <span className="text-brand italic">trabajo</span></>;
        default: return <>Estudio</>;
    }
};

const TalleristaLayout: React.FC<TalleristaLayoutProps> = ({ children }) => {
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [navExpanded, setNavExpanded] = useState(false);
    const location = useLocation();
    const navigate = useNavigate();
    const { profile } = useAuth();
    const { loadError, loadAllData } = useData();

    const handleLogout = async () => {
        await logoutAndRedirect('/login');
    };

    const displayName = presentDisplayName(profile?.full_name || profile?.email?.split('@')[0] || 'Estudio');
    const isStaff = profile?.role === 'staff';

    // Staff cannot see team management or settings
    const staffHiddenPaths = ['/team', '/settings'];
    const filteredNavItems = isStaff ? navItems.filter(item => !staffHiddenPaths.includes(item.path)) : navItems;
    const filteredMenuConfig = isStaff
        ? menuConfig.map(g => ({ ...g, items: g.items.filter(i => !staffHiddenPaths.includes(i.path)) })).filter(g => g.items.length > 0)
        : menuConfig;

    return (
        <div className="flex flex-col md:flex-row h-screen w-full bg-neutral-base overflow-hidden">
            {/* Side menu: icons on tablet (768–1180), full labels from 1180px or when expanded. */}
            <div className={`hidden md:block h-full py-4 pl-4 md:py-6 md:pl-6 shrink-0 ${navExpanded ? 'w-[19.5rem]' : 'w-[5.75rem]'} min-[1180px]:w-[19.5rem]`}>
                <div className="bg-white border border-neutral-border flex flex-col h-full rounded-2xl soft-shadow flex-shrink-0 animate-fade-in overflow-hidden">
                    <div className={`flex h-full flex-col ${navExpanded ? 'p-4 min-[1180px]:p-6' : 'p-2 min-[1180px]:p-6'}`}>
                        <div className={`mb-4 flex gap-3 min-[1180px]:mb-8 ${navExpanded ? 'items-start' : 'flex-col items-center min-[1180px]:flex-row min-[1180px]:items-start'}`}>
                            <div className="relative w-11 h-11 overflow-hidden bg-brand rounded-[14px] flex items-center justify-center text-white font-bold text-lg shrink-0 shadow-sm">
                                <DiagonalPattern dark className="opacity-45" />
                                {displayName.charAt(0).toUpperCase()}
                            </div>
                            <div className={`min-w-0 flex-1 ${navExpanded ? 'block' : 'hidden min-[1180px]:block'}`}>
                            <h1 className="font-display text-[17px] font-bold text-neutral-textMain leading-tight">Casa Rosier</h1>
                                <p className="break-words text-[15px] font-semibold leading-snug text-neutral-textSec">{displayName}</p>
                                <p className="text-[14px] leading-snug text-neutral-textSec">Estudio</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setNavExpanded(open => !open)}
                                aria-expanded={navExpanded}
                                aria-label={navExpanded ? 'Contraer menú' : 'Expandir menú'}
                                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-neutral-border text-neutral-textMain hover:bg-neutral-alt min-[1180px]:hidden"
                            >
                                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={navExpanded ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'} /></svg>
                            </button>
                        </div>

                        <nav className="menu-typography-110 space-y-0.5 min-h-0 flex-1 overflow-y-auto py-1">
                            {filteredNavItems.map((item, index) => (
                                <React.Fragment key={item.path}>
                                    {(index === 0 || filteredNavItems[index - 1]?.section !== item.section) && (
                                        <p className={`eyebrow px-3.5 pb-1 pt-2 first:pt-0 ${navExpanded ? 'block' : 'hidden min-[1180px]:block'}`}>{item.section}</p>
                                    )}
                                    <button
                                        onClick={() => navigate(item.path)}
                                        aria-label={item.label}
                                        title={item.label}
                                        className={`w-full flex items-center gap-3 px-3.5 py-2 min-h-[44px] rounded-[10px] transition-colors duration-200 group ${location.pathname === item.path
                                            ? 'bg-brand text-white'
                                            : 'text-neutral-textSec hover:bg-neutral-alt hover:text-brand'
                                            }`}
                                    >
                                        <div className="transition-transform duration-200 shrink-0 group-hover:scale-105">
                                            {item.icon}
                                        </div>
                                        <span className={`text-left text-[14px] leading-snug ${navExpanded ? 'inline' : 'hidden min-[1180px]:inline'} ${location.pathname === item.path ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
                                    </button>
                                </React.Fragment>
                            ))}
                        </nav>

                         <div className="mt-2 pt-2 border-t border-neutral-border shrink-0">
                            {!isStaff && (
                                 <button
                                     onClick={() => navigate('/settings')}
                                     aria-label="Administración del taller"
                                     className={`mb-1 w-full flex items-center gap-3 px-3.5 min-h-[44px] rounded-[10px] transition-colors duration-200 group ${location.pathname === '/settings' ? 'bg-brand text-white' : 'text-neutral-textSec hover:bg-neutral-alt hover:text-brand'}`}
                                 >
                                     <svg className="w-5 h-5 shrink-0 transition-transform duration-200 group-hover:rotate-45" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.2 3.5a6.9 6.9 0 0 0-.1-1.1l2-1.5-2-3.4-2.4 1a7.2 7.2 0 0 0-1.9-1.1L15.5 3h-4l-.4 2.9a7.2 7.2 0 0 0-1.9 1.1l-2.4-1-2 3.4 2 1.5a6.9 6.9 0 0 0 0 2.2l-2 1.5 2 3.4 2.4-1a7.2 7.2 0 0 0 1.9 1.1l.4 2.9h4l.4-2.9a7.2 7.2 0 0 0 1.9-1.1l2.4 1 2-3.4-2-1.5c.1-.4.1-.7.1-1.1Z" /></svg>
                                     <span className={`text-left text-[14px] leading-snug ${navExpanded ? 'inline' : 'hidden min-[1180px]:inline'} ${location.pathname === '/settings' ? 'font-semibold' : 'font-medium'}`}>Administración del taller</span>
                                 </button>
                             )}
                            <button
                                onClick={handleLogout}
                                aria-label="Salir"
                                className="w-full flex items-center gap-3 px-3.5 min-h-[44px] rounded-[10px] text-neutral-textHelper hover:text-brand hover:bg-neutral-alt transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                                <span className={`text-[14px] font-medium ${navExpanded ? 'inline' : 'hidden min-[1180px]:inline'}`}>Salir</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <main className="flex-1 flex flex-col h-full overflow-hidden relative">
                <div className="p-3 md:p-6 shrink-0">
                    <header className="bg-white border border-neutral-border rounded-2xl px-5 md:px-7 py-4 md:py-5 flex justify-between items-center gap-4 relative z-40">
                        <div className="flex flex-col min-w-0">
                            <h2 className="ui-page-title text-neutral-textMain">
                                {getViewTitle(location.pathname)}
                            </h2>
                        </div>

                         <div className="ml-auto flex items-center gap-2 shrink-0">
                             <div id="tallerista-header-actions" className="flex items-center shrink-0"></div>
                             <ThemeToggle compact />
                             <div className="hidden sm:flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand font-bold text-[14px]">{displayName.charAt(0).toUpperCase()}</div>
                         </div>

                        <button
                            onClick={() => setIsMenuOpen(true)}
                            className="flex md:hidden flex-col justify-center items-end gap-[6px] w-[44px] h-[44px] shrink-0 hover:opacity-60 transition-opacity"
                            aria-label="Abrir menú"
                        >
                            <div className="w-[26px] h-[2px] bg-neutral-textMain rounded-full"></div>
                            <div className="w-[26px] h-[2px] bg-neutral-textMain rounded-full"></div>
                            <div className="w-[18px] h-[2px] bg-neutral-textMain rounded-full"></div>
                        </button>
                    </header>
                    {loadError && (
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#EFC9BE] bg-[#FFF8F5] px-4 py-3 text-sm text-[#9E3B2B]" role="alert">
                            <span>{loadError}</span>
                            <button type="button" onClick={() => void loadAllData()} className="min-h-[40px] rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#9E3B2B] hover:bg-[#F8E1DA]">
                                Reintentar
                            </button>
                        </div>
                    )}
                </div>

                <div className="flex-1 overflow-hidden">
                    {children}
                </div>
            </main>

            {/* Mobile primary navigation: the four most-used destinations stay reachable at all times. */}
            <nav
                aria-label="Navegación principal móvil"
                className="fixed inset-x-3 bottom-3 z-[80] grid grid-cols-5 gap-1 rounded-[28px] border border-neutral-border bg-white/95 px-3 pb-2 pt-3 shadow-[0_14px_34px_rgba(17,17,17,0.14)] backdrop-blur-xl md:hidden"
                style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
            >
                {mobilePrimaryPaths.map(path => navItems.find(item => item.path === path)).filter((item): item is typeof navItems[number] => !!item).map(item => {
                    const isActive = location.pathname === item.path;
                    return (
                        <button
                            key={item.path}
                            type="button"
                            onClick={() => navigate(item.path)}
                            aria-current={isActive ? 'page' : undefined}
                            className={`flex min-h-[72px] min-w-0 flex-col items-center justify-center gap-2 rounded-[18px] px-1 py-2 transition-colors duration-180 ${isActive ? 'text-[#5F5F5F]' : 'text-[#707070] hover:text-[#404040]'}`}
                        >
                            <span className="mobile-nav-icon flex h-7 w-7 items-center justify-center [&>svg]:h-7 [&>svg]:w-7">
                                {item.icon}
                            </span>
                            <span className={`max-w-full text-center font-medium leading-tight tracking-[-0.02em] ${mobilePrimaryLabels[item.path].length > 14 ? 'whitespace-normal text-[11px]' : 'truncate text-[15px]'}`}>
                                {mobilePrimaryLabels[item.path]}
                            </span>
                        </button>
                    );
                })}
            </nav>

            {/* Mobile Menu Drawer */}
            {isMenuOpen && (
                <>
                    <div
                        className="fixed inset-0 bg-black/35 backdrop-blur-sm z-[100] animate-fade-in"
                        onClick={() => setIsMenuOpen(false)}
                    />
                    <div className="fixed top-0 right-0 h-full w-[280px] md:w-[340px] bg-white z-[110] shadow-2xl transition-transform duration-300 flex flex-col overflow-hidden rounded-l-3xl">
                     <div className="px-6 py-5 border-b border-neutral-border flex justify-between items-start gap-4 bg-neutral-surface">
                            <div>
                                 <h3 className="ui-section-title text-neutral-textMain">Menú</h3>
                                 <p className="mt-1 break-words text-[15px] font-semibold leading-snug text-neutral-textMain">{displayName}</p>
                                 <p className="text-[14px] text-neutral-textSec mt-0.5">Estudio de cerámica</p>
                     </div>
                            <button onClick={() => setIsMenuOpen(false)} aria-label="Cerrar menú" className="w-10 h-10 -mr-2 rounded-full text-neutral-textMain hover:bg-neutral-sec flex items-center justify-center transition-colors">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>

                         <div className="menu-typography-110 flex-1 overflow-y-auto no-scrollbar p-5 space-y-8">
                            {filteredMenuConfig.map((group) => (
                                <div key={group.group} className="space-y-2">
                                    <h4 className="eyebrow px-3">{group.group}</h4>
                                    <div className="space-y-1">
                                        {group.items.map(item => (
                                            <button
                                                key={item.path}
                                                onClick={() => { navigate(item.path); setIsMenuOpen(false); }}
                                                className={`w-full text-left px-4 min-h-[44px] py-3 rounded-[10px] text-[15px] transition-colors duration-200 flex items-center ${location.pathname === item.path
                                                    ? 'bg-brand text-white font-semibold'
                                                    : 'text-neutral-textMain hover:bg-neutral-alt font-medium'
                                                    }`}
                                            >
                                                {item.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}

                            <div className="pt-4 border-t border-neutral-border">
                                <button
                                    onClick={() => { handleLogout(); setIsMenuOpen(false); }}
                                    className="w-full text-left px-4 py-3 text-brand font-semibold text-[14px] hover:opacity-70 transition-opacity"
                                >
                                    Cerrar sesión
                                </button>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

export default TalleristaLayout;

