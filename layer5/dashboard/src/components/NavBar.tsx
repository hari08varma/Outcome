import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Menu, Settings, X } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useAlerts } from '../hooks/useAlerts';

interface NavItem {
  label: string;
  path: string;
  showAlertDot?: boolean;
  icon?: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Overview', path: '/dashboard' },
  { label: 'Agent', path: '/dashboard/agent' },
  { label: 'Actions', path: '/dashboard/actions' },
  { label: 'Alerts', path: '/dashboard/alerts', showAlertDot: true },
  { label: 'Simulate', path: '/dashboard/simulate' },
  { label: 'Signals', path: '/dashboard/signals' },
  { label: 'Contracts', path: '/dashboard/contracts' },
  { label: 'Discrepancies', path: '/dashboard/discrepancies', showAlertDot: true },
  { label: 'Recommendations', path: '/dashboard/recommendations' },
  { label: 'Settings', path: '/dashboard/settings', icon: <Settings size={16} /> },
];

function isActive(currentPath: string, itemPath: string): boolean {
  if (itemPath === '/dashboard') {
    return currentPath === '/dashboard';
  }
  return currentPath.startsWith(itemPath);
}

export default function NavBar(): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const { unresolvedCount } = useAlerts('all', false);

  useEffect(() => {
    let mounted = true;
    void supabase.auth.getUser().then(({ data: { user } }) => {
      if (mounted) {
        setEmail(user?.email ?? '');
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? '');
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const activeRoute = useMemo(() => location.pathname, [location.pathname]);

  useEffect(() => {
    setMenuOpen(false);
  }, [activeRoute]);

  const onSignOut = async (): Promise<void> => {
    await supabase.auth.signOut();
    navigate('/auth');
  };

  return (
    <header className="border-b border-[#1a1a24] bg-[#0a0a0f] sticky top-0 z-50">
      <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-10">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[#b8ff00] rounded-lg flex items-center justify-center text-black font-bold">L5</div>
            <span className="text-white font-bold text-lg tracking-tight">Layerinfinite</span>
          </div>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium h-16">
            {NAV_ITEMS.map((item) => {
              const active = isActive(activeRoute, item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={active
                    ? 'text-[#b8ff00] border-b-2 border-[#b8ff00] h-full flex items-center px-1 gap-2'
                    : 'text-[#a1a1aa] hover:text-white h-full flex items-center px-1 gap-2'}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.showAlertDot && unresolvedCount > 0 && (
                    <span className="inline-flex items-center justify-center min-w-[16px] h-4 rounded-full bg-[#ff4444] text-[10px] text-white px-1">
                      {unresolvedCount > 99 ? '99+' : unresolvedCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-5">
          <span className="hidden md:inline text-xs text-[#a1a1aa]">{email}</span>
          <button className="hidden md:inline text-sm text-white hover:text-[#b8ff00]" onClick={onSignOut}>Sign Out</button>
          <button
            className="md:hidden text-[#a1a1aa] hover:text-white"
            onClick={() => setMenuOpen((value) => !value)}
            aria-label="Toggle menu"
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="md:hidden border-t border-[#1a1a24] bg-[#0a0a0f] px-4 py-3 space-y-2">
          {NAV_ITEMS.map((item) => {
            const active = isActive(activeRoute, item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={active
                  ? 'flex items-center justify-between rounded-lg px-3 py-2 bg-[#1a1a24] text-[#b8ff00]'
                  : 'flex items-center justify-between rounded-lg px-3 py-2 text-[#a1a1aa] hover:bg-[#1a1a24] hover:text-white'}
              >
                <span className="flex items-center gap-2">
                  {item.icon}
                  <span>{item.label}</span>
                </span>
                {item.showAlertDot && unresolvedCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[16px] h-4 rounded-full bg-[#ff4444] text-[10px] text-white px-1">
                    {unresolvedCount > 99 ? '99+' : unresolvedCount}
                  </span>
                )}
              </Link>
            );
          })}
          <div className="pt-2 border-t border-[#1a1a24]">
            <p className="text-xs text-[#52525b] px-3 pb-2">{email}</p>
            <button className="text-sm text-white px-3 py-2" onClick={onSignOut}>Sign Out</button>
          </div>
        </div>
      )}
    </header>
  );
}
