import { useState, useEffect, useCallback } from 'react';
import { Phone, MessageSquare, Calendar, Eye, Settings, Zap } from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import { getClients, getStats } from '../lib/api';
import { formatPhone } from '../lib/utils';

export default function Clients() {
  const [clients, setClients] = useState([]);
  const [clientStats, setClientStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedClientId, setSelectedClientId] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [sortBy, setSortBy] = useState('name');
  const [filterStatus, setFilterStatus] = useState('all');

  const loadClients = useCallback(() => {
    setLoading(true);
    setError(null);

    getClients()
      .then(data => {
        const list = Array.isArray(data) ? data : data.clients || [];
        setClients(list);

        // Load stats for each client
        const statsPromises = list.map(c => {
          const id = c.id || c.client_id;
          return getStats(id)
            .then(stats => ({ id, stats }))
            .catch(() => ({ id, stats: null }));
        });

        Promise.all(statsPromises).then(results => {
          const statsMap = {};
          results.forEach(({ id, stats }) => {
            statsMap[id] = stats;
          });
          setClientStats(statsMap);
        });

        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load clients');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  const getFilteredAndSortedClients = () => {
    let filtered = clients;

    // Filter by status
    if (filterStatus !== 'all') {
      filtered = filtered.filter(c => {
        const isActive = c.active !== false;
        return filterStatus === 'active' ? isActive : !isActive;
      });
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      if (sortBy === 'name') {
        return (a.business_name || '').localeCompare(b.business_name || '');
      }
      if (sortBy === 'activity') {
        const idA = a.id || a.client_id;
        const idB = b.id || b.client_id;
        const statsA = clientStats[idA]?.calls_this_week || 0;
        const statsB = clientStats[idB]?.calls_this_week || 0;
        return statsB - statsA;
      }
      if (sortBy === 'plan') {
        return (a.plan || '').localeCompare(b.plan || '');
      }
      return 0;
    });

    return sorted;
  };

  const handleViewClient = (clientId) => {
    localStorage.setItem('elyvn_client', clientId);
    setSelectedClientId(clientId);
  };

  const filteredClients = getFilteredAndSortedClients();

  const totalClients = Array.isArray(clients) ? clients.length : 0;
  const activeClients = Array.isArray(clients) ? clients.filter(c => c.active !== false).length : 0;
  const totalCalls = clientStats && typeof clientStats === 'object' ? Object.values(clientStats).reduce((sum, stats) => sum + (stats?.calls_this_week || 0), 0) : 0;
  const totalMessages = clientStats && typeof clientStats === 'object' ? Object.values(clientStats).reduce((sum, stats) => sum + (stats?.messages_this_week || 0), 0) : 0;

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 16, fontFamily: "'Cormorant Garamond', Georgia, serif" }}>All Clients</h1>
        <div className="grid-4">
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>Total Clients</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#D4AF37', fontFamily: "'Cormorant Garamond', Georgia, serif" }}>{totalClients}</div>
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>Active</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#4ade80', fontFamily: "'Cormorant Garamond', Georgia, serif" }}>{activeClients}</div>
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>Calls This Week</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#60a5fa', fontFamily: "'Cormorant Garamond', Georgia, serif" }}>{totalCalls}</div>
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>Messages This Week</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#D4AF37', fontFamily: "'Cormorant Garamond', Georgia, serif" }}>{totalMessages}</div>
          </div>
        </div>
      </div>

      {/* Filters and Sorting */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 20,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#666' }}>Status:</label>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#666' }}>Sort by:</label>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
          >
            <option value="name">Name</option>
            <option value="activity">Activity (This Week)</option>
            <option value="plan">Plan</option>
          </select>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(220,38,38,0.1)',
          border: '1px solid rgba(220,38,38,0.2)',
          borderRadius: 14,
          color: '#f87171',
          fontSize: 13,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button className="btn-ghost" onClick={loadClients} style={{ color: '#f87171' }}>Retry</button>
        </div>
      )}

      {/* Client List */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#444' }}>
          <div className="spinner" /> Loading clients...
        </div>
      ) : filteredClients.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: '#444' }}>
          No clients found
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filteredClients.map(client => {
            const id = client.id || client.client_id;
            const stats = clientStats[id];
            const isActive = client.active !== false;

            return (
              <div key={id} className="card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                  {/* Left: Client Info */}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <div style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: isActive ? '#4ade80' : '#444',
                      }} />
                      <span style={{ fontSize: 14, fontWeight: 600 }}>
                        {client.business_name}
                      </span>
                      {client.plan && (
                        <span style={{
                          fontSize: 10,
                          fontWeight: 600,
                          background: '#D4AF37',
                          color: '#000',
                          padding: '2px 8px',
                          borderRadius: 6,
                          textTransform: 'uppercase',
                        }}>
                          {client.plan}
                        </span>
                      )}
                      {client.industry && (
                        <span style={{ fontSize: 11, color: '#444' }}>
                          {client.industry}
                        </span>
                      )}
                    </div>

                    {/* Contact Info */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, color: '#666', marginBottom: 8 }}>
                      {client.owner_name && (
                        <span>{client.owner_name}</span>
                      )}
                      {client.phone && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Phone size={12} />
                          {formatPhone(client.phone)}
                        </span>
                      )}
                      {client.owner_email && (
                        <span>{client.owner_email}</span>
                      )}
                    </div>

                    {/* Stats */}
                    {stats && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#60a5fa' }}>
                          <Phone size={12} />
                          <span>{stats.calls_this_week || 0} calls</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#D4AF37' }}>
                          <MessageSquare size={12} />
                          <span>{stats.messages_this_week || 0} messages</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#4ade80' }}>
                          <Calendar size={12} />
                          <span>{stats.bookings_this_week || 0} bookings</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Right: Actions */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn-secondary"
                      onClick={() => handleViewClient(id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', border: '1px solid rgba(212,175,55,0.3)', color: '#D4AF37', background: 'transparent' }}
                    >
                      <Eye size={12} /> View
                    </button>
                    <a
                      href="/settings"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        padding: '8px 12px',
                        background: '#222',
                        border: '1px solid rgba(212,175,55,0.3)',
                        borderRadius: 10,
                        color: '#D4AF37',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 500,
                        textDecoration: 'none',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = 'rgba(212,175,55,0.08)';
                        e.currentTarget.style.borderColor = 'rgba(212,175,55,0.5)';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = '#222';
                        e.currentTarget.style.borderColor = 'rgba(212,175,55,0.3)';
                      }}
                    >
                      <Settings size={12} />
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
