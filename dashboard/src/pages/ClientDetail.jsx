import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, Phone, MessageSquare, Calendar, DollarSign, TrendingUp } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import StatsCard from '../components/StatsCard';
import { getClients, getStats, getCalls, getMessages, getLeads, getBookings } from '../lib/api';

export default function ClientDetail() {
  const navigate = useNavigate();
  const clientId = localStorage.getItem('elyvn_client') || '';
  const [client, setClient] = useState(null);
  const [stats, setStats] = useState(null);
  const [calls, setCalls] = useState([]);
  const [messages, setMessages] = useState([]);
  const [leads, setLeads] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadData = useCallback(() => {
    if (!clientId) return;

    setLoading(true);
    setError(null);

    Promise.all([
      getClients().then(data => {
        const list = Array.isArray(data) ? data : data.clients || [];
        const found = list.find(c => (c.id || c.client_id) === clientId);
        return found;
      }).catch(() => null),
      getStats(clientId).catch(() => null),
      getCalls(clientId, { limit: 5 }).catch(() => ({ calls: [] })),
      getMessages(clientId, { limit: 5 }).catch(() => ({ messages: [] })),
      getLeads(clientId).catch(() => ({ leads: [] })),
      getBookings(clientId, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], new Date().toISOString().split('T')[0]).catch(() => ({ bookings: [] })),
    ])
      .then(([clientData, statsData, callsData, msgsData, leadsData, bookingsData]) => {
        setClient(clientData);
        setStats(statsData);
        setCalls(Array.isArray(callsData) ? callsData : callsData.calls || []);
        setMessages(Array.isArray(msgsData) ? msgsData : msgsData.messages || []);
        setLeads(Array.isArray(leadsData) ? leadsData : leadsData.leads || []);
        setBookings(Array.isArray(bookingsData) ? bookingsData : bookingsData.bookings || []);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load client data');
        setLoading(false);
      });
  }, [clientId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  if (loading) {
    return (
      <div className="fade-in">
        <button className="btn-ghost" onClick={() => navigate('/clients')} style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
          <ChevronLeft size={16} /> Back to Clients
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555' }}>
          <div className="spinner" /> Loading client details...
        </div>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="fade-in">
        <button className="btn-ghost" onClick={() => navigate('/clients')} style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
          <ChevronLeft size={16} /> Back to Clients
        </button>
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#555' }}>
          Client not found
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      {/* Back Button */}
      <button className="btn-ghost" onClick={() => navigate('/clients')} style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ChevronLeft size={16} /> Back to Clients
      </button>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: client.active !== false ? '#16A34A' : '#555',
          }} />
          <h1 style={{ fontSize: 24, fontWeight: 600 }}>
            {client.business_name}
          </h1>
          {client.plan && (
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              background: '#D4AF37',
              color: '#000',
              padding: '4px 10px',
              borderRadius: 4,
              textTransform: 'uppercase',
            }}>
              {client.plan} Plan
            </span>
          )}
        </div>

        {/* Client Info */}
        <div className="card" style={{ padding: 16, marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Owner</div>
              <div style={{ fontSize: 13 }}>{client.owner_name || '--'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Email</div>
              <div style={{ fontSize: 13 }}>{client.owner_email || '--'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Phone</div>
              <div style={{ fontSize: 13 }}>{client.phone || client.owner_phone || '--'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Industry</div>
              <div style={{ fontSize: 13 }}>{client.industry || '--'}</div>
            </div>
          </div>
        </div>
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
          value={stats?.calls_this_week ?? 0}
          trend={stats?.calls_trend}
          icon={Phone}
          color="#3B82F6"
        />
        <StatsCard
          title="Messages This Week"
          value={stats?.messages_this_week ?? 0}
          trend={stats?.messages_trend}
          icon={MessageSquare}
          color="#C9A84C"
        />
        <StatsCard
          title="Appointments Booked"
          value={stats?.bookings_this_week ?? 0}
          trend={stats?.bookings_trend}
          icon={Calendar}
          color="#16A34A"
        />
        <StatsCard
          title="Estimated Revenue"
          value={`$${(stats?.estimated_revenue ?? 0).toLocaleString()}`}
          trend={stats?.revenue_trend}
          icon={DollarSign}
          color="#EAB308"
        />
      </div>

      {/* Dashboard Links */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Quick Access</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <a
            href="/calls"
            style={{
              padding: 16,
              background: '#0d0d0d',
              border: '1px solid #333',
              borderRadius: 8,
              textDecoration: 'none',
              color: '#e0d8c8',
              transition: 'all 0.15s',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = '#1a1a1a';
              e.currentTarget.style.borderColor = '#444';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = '#0d0d0d';
              e.currentTarget.style.borderColor = '#333';
            }}
          >
            <Phone size={16} color="#3B82F6" />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>View Calls</div>
              <div style={{ fontSize: 11, color: '#888' }}>All call recordings</div>
            </div>
          </a>
          <a
            href="/messages"
            style={{
              padding: 16,
              background: '#0d0d0d',
              border: '1px solid #333',
              borderRadius: 8,
              textDecoration: 'none',
              color: '#e0d8c8',
              transition: 'all 0.15s',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = '#1a1a1a';
              e.currentTarget.style.borderColor = '#444';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = '#0d0d0d';
              e.currentTarget.style.borderColor = '#333';
            }}
          >
            <MessageSquare size={16} color="#C9A84C" />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>View Messages</div>
              <div style={{ fontSize: 11, color: '#888' }}>SMS conversations</div>
            </div>
          </a>
          <a
            href="/pipeline"
            style={{
              padding: 16,
              background: '#0d0d0d',
              border: '1px solid #333',
              borderRadius: 8,
              textDecoration: 'none',
              color: '#e0d8c8',
              transition: 'all 0.15s',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = '#1a1a1a';
              e.currentTarget.style.borderColor = '#444';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = '#0d0d0d';
              e.currentTarget.style.borderColor = '#333';
            }}
          >
            <TrendingUp size={16} color="#16A34A" />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>View Pipeline</div>
              <div style={{ fontSize: 11, color: '#888' }}>Lead management</div>
            </div>
          </a>
          <a
            href="/settings"
            style={{
              padding: 16,
              background: '#0d0d0d',
              border: '1px solid #333',
              borderRadius: 8,
              textDecoration: 'none',
              color: '#e0d8c8',
              transition: 'all 0.15s',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = '#1a1a1a';
              e.currentTarget.style.borderColor = '#444';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = '#0d0d0d';
              e.currentTarget.style.borderColor = '#333';
            }}
          >
            <TrendingUp size={16} color="#D4AF37" />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Settings</div>
              <div style={{ fontSize: 11, color: '#888' }}>Configuration</div>
            </div>
          </a>
        </div>
      </div>

      {/* Data Sections */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 28 }}>
        {/* Recent Calls */}
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Recent Calls ({calls.length})</h2>
          {calls.length === 0 ? (
            <div className="card" style={{ padding: 16, textAlign: 'center', color: '#555', fontSize: 13 }}>
              No recent calls
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {calls.slice(0, 5).map((call, i) => (
                <div key={i} className="card" style={{ padding: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                    {call.from_number || call.caller_phone || 'Unknown'}
                  </div>
                  <div style={{ fontSize: 11, color: '#888' }}>
                    {call.summary || call.outcome || 'Call recorded'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Messages */}
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Recent Messages ({messages.length})</h2>
          {messages.length === 0 ? (
            <div className="card" style={{ padding: 16, textAlign: 'center', color: '#555', fontSize: 13 }}>
              No recent messages
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {messages.slice(0, 5).map((msg, i) => (
                <div key={i} className="card" style={{ padding: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                    {msg.from_number || msg.sender_phone || 'Unknown'}
                  </div>
                  <div style={{ fontSize: 11, color: '#888' }}>
                    {(msg.original_message || msg.body || 'Message received').substring(0, 60)}...
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Leads & Bookings */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Active Leads */}
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Active Leads ({leads.filter(l => l.stage !== 'completed' && l.stage !== 'lost').length})</h2>
          {leads.filter(l => l.stage !== 'completed' && l.stage !== 'lost').length === 0 ? (
            <div className="card" style={{ padding: 16, textAlign: 'center', color: '#555', fontSize: 13 }}>
              No active leads
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {leads.filter(l => l.stage !== 'completed' && l.stage !== 'lost').slice(0, 5).map((lead, i) => (
                <div key={i} className="card" style={{ padding: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                    {lead.name || lead.phone || 'Unknown'}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, color: '#888', textTransform: 'capitalize' }}>
                      {lead.stage || 'new'}
                    </span>
                    <span style={{ fontSize: 11, color: '#D4AF37' }}>
                      Score: {lead.score ?? '--'}/10
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Bookings */}
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Recent Bookings ({bookings.length})</h2>
          {bookings.length === 0 ? (
            <div className="card" style={{ padding: 16, textAlign: 'center', color: '#555', fontSize: 13 }}>
              No bookings
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {bookings.slice(0, 5).map((booking, i) => (
                <div key={i} className="card" style={{ padding: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                    {booking.name || booking.title || 'Booking'}
                  </div>
                  <div style={{ fontSize: 11, color: '#888' }}>
                    {new Date(booking.start_time || booking.date).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
