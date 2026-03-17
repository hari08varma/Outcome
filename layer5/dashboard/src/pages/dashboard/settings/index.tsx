import React from 'react';
import { Bot, Key, Zap } from 'lucide-react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';

interface SettingsNavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

const ITEMS: SettingsNavItem[] = [
  { label: 'API Keys', path: '/dashboard/settings/api-keys', icon: <Key size={16} /> },
  { label: 'Agents', path: '/dashboard/settings/agents', icon: <Bot size={16} /> },
  { label: 'Actions', path: '/dashboard/settings/actions', icon: <Zap size={16} /> },
];

function isActive(pathname: string, target: string): boolean {
  return pathname === target || pathname.startsWith(`${target}/`);
}

export default function SettingsLayout(): React.ReactElement {
  const location = useLocation();

  if (location.pathname === '/dashboard/settings') {
    return <Navigate to="/dashboard/settings/api-keys" replace />;
  }

  return (
    <div className="flex gap-8">
      <aside className="w-[200px] shrink-0">
        <h1 className="text-lg font-semibold text-white mb-6">Settings</h1>
        <nav className="flex flex-col gap-1">
          {ITEMS.map((item) => {
            const active = isActive(location.pathname, item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={active
                  ? 'flex items-center gap-2 px-3 py-2 rounded-lg bg-[#1a1a24] text-white font-medium text-sm'
                  : 'flex items-center gap-2 px-3 py-2 rounded-lg text-[#a1a1aa] text-sm hover:bg-[#1a1a24] hover:text-white'}
              >
                {item.icon}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
      <section className="flex-1 pl-8 min-w-0">
        <Outlet />
      </section>
    </div>
  );
}
