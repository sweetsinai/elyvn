import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, MessageSquare, Calendar, DollarSign, Users, Activity, Zap, BarChart3, Plus, Eye, Settings } from 'lucide-react';
import StatsCard from '../components/StatsCard';
import StatusBadge from '../components/StatusBadge';
import { getClients, getStats, getCalls, getMessages, getBookings, getDailySchedule } from '../lib/api';
import { formatPhone, timeAgo, truncate, formatTime, formatDate } from '../lib/utils';

export default function Dashboard() {
  const navigate = useNavigate();
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState(() => localStorage.getItem('elyvn_client') || '');
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load clients (includes platform-wide client count)
  useEffect(() => {
    let cancelled = false;
    getClients()
      .then(data => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : data.clients || [];
        setClients(list);
        // Validate stored client ID exists in the list; reset if stale
        const storedId = clientId;
        const ids = list.map(c => c.id || c.client_id);
        if (list.length > 0 && (!storedId || !ids.includes(storedId))) {
          const first = ids[0];
          setClientId(first);
          localStorage.setItem('elyvn_client', first);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Load data
  const loadData = useCallback(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);

    // Get today's date range for bookings
    const today = new Date();
    const startDate = today.toISOString().split('T')[0];
    const endDate = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    Promise.all([
      getStats(clientId).catch(() => null),
      getCalls(clientId, { limit: 10 }).catch(() => ({ calls: [] })),
      getMessages(clientId, { limit: 10 }).catch(() => ({ messages: [] })),
      getBookings(clientId, startDate, endDate).catch(() => []),
      getDailySchedule(clientId).catch(() => null),
    ])
      .then(([statsData, callsData, msgsData, bookingsData, scheduleData]) => {
        setStats(statsData);
        const calls = (Array.isArray(callsData) ? callsData : callsData.calls || []).map(c => ({ ...c, _type: 'call' }));
        const msgs = (Array.isArray(msgsData) ? msgsData : msgsData.messages || []).map(m => ({ ...m, _type: 'message' }));
        const combined = [...calls, ...msgs]
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 10);
        setActivity(combined);
        setBookings(Array.isArray(bookingsData) ? bookingsData : bookingsData.bookings || []);
        setSchedule(scheduleData);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load data');
        setLoading(false);
      });
  }, [clientId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleClientChange = (e) => {
    const id = e.target.value;
    setClientId(id);
    localStorage.setItem('elyvn_client', id);
  };

  // Calculate platform-wide stats
  const totalClients = clients.length;
  const systemHealth = 'Healthy'; // Could be enhanced with actual health endpoint

  return (
    <div className="fade-in">
      {/* Platform-Wide Stats Bar */}
      <div className="card" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 16,
        padding: 20,
        marginBottom: 24,
        borderBottom: `1px solid rgba(212,175,55,0.12)`,
      }}>
        <div>
          <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            Total Clients
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, color: '#fff' }}>
            {totalClients}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            Total Calls Today
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, color: '#fff' }}>
            {loading ? '--' : (stats?.calls_today ?? 0)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            Active AI Agents
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, color: '#D4AF37' }}>
            {totalClients}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            System Health
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, color: '#4ade80' }}>
            {systemHealth}
          </div>
        </div>
      </div>

      {/* Header with Client Selector */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 600, color: '#fff', fontFamily: "'Cormorant Garamond', Georgia, serif" }}>Dashboard</h1>
        <select
          value={clientId}
          onChange={handleClientChange}
          style={{
            minWidth: 200,
            padding: '8px 12px',
            background: '#111111',
            border: '1px solid rgba(212,175,55,0.12)',
            borderRadius: 14,
            color: '#fff',
            fontSize: 13,
          }}
        >
          {clients.length === 0 && <option value="">No clients</option>}
          {clients.map(c => (
            <option key={c.id || c.client_id} value={c.id || c.client_id}>
              {c.business_name}
            </option>
          ))}
        </select>
      </div>

      {/* Quick Actions */}
      <div style={{
        display: 'flex',
        gap: 12,
        marginBottom: 28,
      }}>
        <button
          className="btn-primary"
          onClick={() => navigate('/provision')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 16px',
            background: '#D4AF37',
            border: 'none',
            borderRadius: 14,
            color: '#0a0a0a',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'opacity 0.2s',
            backdropFilter: 'blur(12px)',
          }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          <Plus size={16} />
          Provision New Client
        </button>
        <button
          className="btn-ghost"
          onClick={() => navigate('/clients')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 16px',
            background: 'transparent',
            border: '1px solid rgba(212,175,55,0.12)',
            borderRadius: 14,
            color: '#fff',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'border-color 0.2s',
            backdropFilter: 'blur(12px)',
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(212,175,55,0.3)'}
          onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(212,175,55,0.12)'}
        >
          <Eye size={16} />
          View All Clients
        </button>
        <button
          className="btn-ghost"
          onClick={() => navigate('/settings')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 16px',
            background: 'transparent',
            border: '1px solid rgba(212,175,55,0.12)',
            borderRadius: 14,
            color: '#fff',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'border-color 0.2s',
            backdropFilter: 'blur(12px)',
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(212,175,55,0.3)'}
          onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(212,175,55,0.12)'}
        >
          <Settings size={16} />
          System Settings
        </button>
      </div>

      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(248,113,113,0.1)',
          border: '1px solid rgba(248,113,113,0.2)',
          borderRadius: 14,
          color: '#f87171',
          fontSize: 13,
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button className="btn-ghost" onClick={loadData} style={{ color: '#f87171' }}>Retry</button>
        </div>
      )}

      {/* Client Stats Cards */}
      <div className="grid-4" style={{ marginBottom: 28 }}>
        <StatsCard
          title="Calls This Week"
          value={loading ? '--' : (stats?.calls_this_week ?? 0)}
          trend={stats?.calls_trend}
          icon={Phone}
          color="#60a5fa"
        />
        <StatsCard
          title="Messages Handled"
          value={loading ? '--' : (stats?.messages_this_week ?? 0)}
          trend={stats?.messages_trend}
          icon={MessageSquare}
          color="#D4AF37"
        />
        <StatsCard
          title="Appointments Booked"
          value={loading ? '--' : (stats?.bookings_this_week ?? 0)}
          trend={stats?.bookings_trend}
          icon={Calendar}
          color="#4ade80"
        />
        <StatsCard
          title="Estimated Revenue"
          value={loading ? '--' : `$${(stats?.estimated_revenue ?? 0).toLocaleString()}`}
          trend={stats?.revenue_trend}
          icon={DollarSign}
          color="#fbbf24"
        />
      </div>

      {/* Two-Column Layout */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '60% 40%',
        gap: 24,
      }}>
        {/* Left: Recent Activity Feed */}
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14, color: '#fff' }}>Recent Activity</h2>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#444' }}>
              <div className="spinner" /> Loading...
            </div>
          ) : activity.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: '#444' }}>
              No recent activity yet
            </div>
          ) : (
            <div>
              {activity.map((item, i) => (
                <div
                  key={item.id || item.call_id || item.message_id || i}
                  className="card"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 16px',
                    marginBottom: 6,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
                  onMouseLeave={e => e.currentTarget.style.background = '#111111'}
                >
                  {item._type === 'call' ? (
                    <Phone size={14} color="#60a5fa" />
                  ) : (
                    <MessageSquare size={14} color="#D4AF37" />
                  )}
                  <span style={{ fontSize: 13, minWidth: 120, color: '#fff' }}>
                    {formatPhone(item.caller_phone || item.from_number || item.sender_phone)}
                  </span>
                  <span style={{ fontSize: 12, color: '#666', flex: 1 }} className="truncate">
                    {item._type === 'call'
                      ? truncate(item.summary || 'Phone call', 50)
                      : truncate(item.original_message || item.body || 'SMS message', 50)
                    }
                  </span>
                  <StatusBadge
                    status={item.outcome || item.status}
                    type={item._type === 'call' ? 'outcome' : 'status'}
                  />
                  <span style={{ fontSize: 11, color: '#444', minWidth: 60, textAlign: 'right' }}>
                    {timeAgo(item.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Today's Schedule & Quick Stats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Today's Schedule */}
          <div>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14, color: '#fff' }}>Today's Schedule</h2>
            <div className="card" style={{ padding: 20 }}>
              {loading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16, color: '#444' }}>
                  <div className="spinner" /> Loading...
                </div>
              ) : bookings.length === 0 ? (
                <div style={{ padding: 16, textAlign: 'center', color: '#444', fontSize: 13 }}>
                  No bookings scheduled for today
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {bookings.slice(0, 4).map((booking, i) => (
                    <div
                      key={booking.id || booking.booking_id || i}
                      style={{
                        padding: '12px',
                        background: 'rgba(255,255,255,0.03)',
                        borderRadius: 14,
                        borderLeft: '3px solid #D4AF37',
                        fontSize: 13,
                      }}
                    >
                      <div style={{ color: '#fff', fontWeight: 500, marginBottom: 4 }}>
                        {booking.client_name || booking.name || 'Booking'}
                      </div>
                      <div style={{ color: '#666', fontSize: 12 }}>
                        {booking.start_time ? formatTime(booking.start_time) : 'Time TBD'} · {booking.service_type || 'Service'}
                      </div>
                    </div>
                  ))}
                  {bookings.length > 4 && (
                    <div style={{ color: '#666', fontSize: 12, textAlign: 'center', paddingTop: 8 }}>
                      +{bookings.length - 4} more
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Quick Stats */}
          <div>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14, color: '#fff' }}>Quick Stats</h2>
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                    AI Response Rate
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: '#4ade80', marginBottom: 4 }}>
                    {loading ? '--' : `${(stats?.response_rate ?? 0).toFixed(0)}%`}
                  </div>
                  <div style={{ fontSize: 12, color: '#444' }}>
                    of incoming requests handled by AI
                  </div>
                </div>
                <div style={{ borderTop: '1px solid rgba(212,175,55,0.12)' }} />
                <div>
                  <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                    Avg Call Duration
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: '#60a5fa', marginBottom: 4 }}>
                    {loading ? '--' : `${Math.round(stats?.avg_call_duration ?? 0)}s`}
                  </div>
                  <div style={{ fontSize: 12, color: '#444' }}>
                    per handled interaction
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
