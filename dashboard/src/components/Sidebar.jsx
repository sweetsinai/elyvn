import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Phone,
  MessageSquare,
  GitBranch,
  Send,
  Settings,
  Zap,
  Brain,
  Users,
  Calendar,
  PlusCircle,
  Webhook,
} from 'lucide-react';
import { useState, useEffect } from 'react';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/calls', label: 'Calls', icon: Phone },
  { path: '/messages', label: 'Messages', icon: MessageSquare },
  { path: '/pipeline', label: 'Pipeline', icon: GitBranch },
  { path: '/intelligence', label: 'Intelligence', icon: Brain },
  { path: '/outreach', label: 'Outreach', icon: Send },
  { path: '/bookings', label: 'Bookings', icon: Calendar },
  { path: '/clients', label: 'Clients', icon: Users },
  { path: '/provision', label: 'Provision', icon: PlusCircle },
  { path: '/integrations', label: 'Integrations', icon: Webhook },
  { path: '/settings', label: 'Settings', icon: Settings },
];

const connections = [
  { name: 'Retell', key: 'retell' },
  { name: 'Telnyx', key: 'telnyx' },
  { name: 'Cal.com', key: 'calcom' },
  { name: 'MCP', key: 'mcp' },
];

export default function Sidebar({ mobileMenuOpen = false, onCloseMobile = () => {} }) {
  const location = useLocation();
  const [health, setHealth] = useState({});

  useEffect(() => {
    const checkHealth = () => {
      fetch('/health')
        .then(r => r.json())
        .then(data => {
          // Map server response shape to connection keys
          const services = data.services || {};
          setHealth({
            mcp: services.mcp || false,
            db: services.db || false,
            retell: data.env_configured?.RETELL_API_KEY || false,
            telnyx: data.env_configured?.TELNYX_API_KEY || false,
            calcom: data.env_configured?.CALCOM_API_KEY || false,
          });
        })
        .catch(() => setHealth({}));
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <aside style={{
      position: 'fixed',
      left: 0,
      top: 0,
      bottom: 0,
      width: 240,
      background: '#0d0d0d',
      borderRight: '1px solid rgba(255,255,255,0.06)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 50,
      transition: 'transform 0.3s ease-out',
      transform: 'translateX(0)',
    }} className="sidebar">
      {/* Logo */}
      <div style={{
        padding: '24px 20px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <Zap size={20} color="#C9A84C" />
        <span style={{
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: '#C9A84C',
        }}>ELYVN</span>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }} aria-label="Main navigation">
        {navItems.map(item => {
          const isActive = item.path === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.path);
          const Icon = item.icon;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              aria-current={isActive ? 'page' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: isActive ? 500 : 400,
                color: isActive ? '#C9A84C' : '#888',
                background: isActive ? 'rgba(201,168,76,0.15)' : 'transparent',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => {
                if (!isActive) {
                  e.currentTarget.style.background = '#141414';
                  e.currentTarget.style.color = '#e0d8c8';
                }
              }}
              onMouseLeave={e => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = '#888';
                }
              }}
            >
              <Icon size={16} />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      {/* Connection Status */}
      <div style={{
        padding: '16px 20px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: '#555',
          marginBottom: 10,
        }}>Connections</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {connections.map(conn => {
            const isUp = health[conn.key] === true || health[conn.key] === 'connected';
            return (
              <div key={conn.key} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: '#888',
              }}>
                <div style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: isUp ? '#16A34A' : '#DC2626',
                  boxShadow: isUp ? '0 0 6px #16A34A' : 'none',
                }} />
                {conn.name}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
