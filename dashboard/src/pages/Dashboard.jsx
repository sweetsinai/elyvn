import { useState, useEffect, useCallback } from 'react';
import { Phone, MessageSquare, Calendar, DollarSign } from 'lucide-react';
import StatsCard from '../components/StatsCard';
import StatusBadge from '../components/StatusBadge';
import { getClients, getStats, getCalls, getMessages } from '../lib/api';
import { formatPhone, timeAgo, truncate } from '../lib/utils';

export default function Dashboard() {
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState(() => localStorage.getItem('elyvn_client') || '');
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load clients
  useEffect(() => {
    let cancelled = false;
    getClients()
      .then(data => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : data.clients || [];
        setClients(list);
        if (!clientId && list.length > 0) {
          const first = list[0].id || list[0].client_id;
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

    Promise.all([
      getStats(clientId).catch(() => null),
      getCalls(clientId, { limit: 10 }).catch(() => ({ calls: [] })),
      getMessages(clientId, { limit: 10 }).catch(() => ({ messages: [] })),
    ])
      .then(([statsData, callsData, msgsData]) => {
        setStats(statsData);
        const calls = (Array.isArray(callsData) ? callsData : callsData.calls || []).map(c => ({ ...c, _type: 'call' }));
        const msgs = (Array.isArray(msgsData) ? msgsData : msgsData.messages || []).map(m => ({ ...m, _type: 'message' }));
        const combined = [...calls, ...msgs]
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 10);
        setActivity(combined);
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

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>Dashboard</h1>
        <select
          value={clientId}
          onChange={handleClientChange}
          style={{ minWidth: 180 }}
        >
          {clients.length === 0 && <option value="">No clients</option>}
          {clients.map(c => (
            <option key={c.id || c.client_id} value={c.id || c.client_id}>
              {c.business_name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(220,38,38,0.1)',
          border: '1px solid rgba(220,38,38,0.2)',
          borderRadius: 8,
          color: '#DC2626',
          fontSize: 13,
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button className="btn-ghost" onClick={loadData} style={{ color: '#DC2626' }}>Retry</button>
        </div>
      )}

      {/* Stats */}
      <div className="grid-4" style={{ marginBottom: 28 }}>
        <StatsCard
          title="Calls This Week"
          value={loading ? '--' : (stats?.calls_this_week ?? 0)}
          trend={stats?.calls_trend}
          icon={Phone}
          color="#3B82F6"
        />
        <StatsCard
          title="Messages Handled"
          value={loading ? '--' : (stats?.messages_this_week ?? 0)}
          trend={stats?.messages_trend}
          icon={MessageSquare}
          color="#C9A84C"
        />
        <StatsCard
          title="Appointments Booked"
          value={loading ? '--' : (stats?.bookings_this_week ?? 0)}
          trend={stats?.bookings_trend}
          icon={Calendar}
          color="#16A34A"
        />
        <StatsCard
          title="Estimated Revenue"
          value={loading ? '--' : `$${(stats?.estimated_revenue ?? 0).toLocaleString()}`}
          trend={stats?.revenue_trend}
          icon={DollarSign}
          color="#EAB308"
        />
      </div>

      {/* Recent Activity */}
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Recent Activity</h2>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555' }}>
            <div className="spinner" /> Loading...
          </div>
        ) : activity.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: '#555' }}>
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
                onMouseEnter={e => e.currentTarget.style.background = '#141414'}
                onMouseLeave={e => e.currentTarget.style.background = '#0d0d0d'}
              >
                {item._type === 'call' ? (
                  <Phone size={14} color="#3B82F6" />
                ) : (
                  <MessageSquare size={14} color="#C9A84C" />
                )}
                <span style={{ fontSize: 13, minWidth: 120 }}>
                  {formatPhone(item.caller_phone || item.from_number || item.sender_phone)}
                </span>
                <span style={{ fontSize: 12, color: '#888', flex: 1 }} className="truncate">
                  {item._type === 'call'
                    ? truncate(item.summary || 'Phone call', 50)
                    : truncate(item.original_message || item.body || 'SMS message', 50)
                  }
                </span>
                <StatusBadge
                  status={item.outcome || item.status}
                  type={item._type === 'call' ? 'outcome' : 'status'}
                />
                <span style={{ fontSize: 11, color: '#555', minWidth: 60, textAlign: 'right' }}>
                  {timeAgo(item.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
