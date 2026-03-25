import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import MessageCard from '../components/MessageCard';
import { getMessages } from '../lib/api';
import { useWebSocket } from '../lib/useWebSocket';

export default function Messages() {
  const clientId = localStorage.getItem('elyvn_client') || '';
  const apiKey = sessionStorage.getItem('elyvn_api_key') || '';
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // WebSocket integration
  const { isConnected, lastEvent } = useWebSocket(apiKey);

  // Filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState('all');

  const loadMessages = useCallback(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);

    getMessages(clientId, {
      page,
      limit: 20,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      status: status === 'all' ? undefined : status,
    })
      .then(data => {
        const list = Array.isArray(data) ? data : data.messages || [];
        setMessages(list);
        setTotalPages(data.total_pages || Math.ceil((data.total || list.length) / 20) || 1);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load messages');
        setLoading(false);
      });
  }, [clientId, page, startDate, endDate, status]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Listen for WebSocket updates
  useEffect(() => {
    if (lastEvent && lastEvent.type === 'new_message') {
      // Refresh messages after a short delay
      setTimeout(() => loadMessages(), 500);
    }
  }, [lastEvent, loadMessages]);

  const handleFilter = () => {
    setPage(1);
    loadMessages();
  };

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>Messages</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: isConnected ? '#16A34A' : '#DC2626' }}>
          <div style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: isConnected ? '#16A34A' : '#DC2626',
            boxShadow: isConnected ? '0 0 6px #16A34A' : 'none',
          }} />
          {isConnected ? 'Live Updates' : 'Disconnected'}
        </div>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 20,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#555' }}>From</label>
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            style={{ width: 140 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#555' }}>To</label>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            style={{ width: 140 }}
          />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value)}>
          <option value="all">All Status</option>
          <option value="auto_replied">Auto Replied</option>
          <option value="escalated">Escalated</option>
          <option value="failed">Failed</option>
        </select>
        <button className="btn-primary" onClick={handleFilter}>Filter</button>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(220,38,38,0.1)',
          border: '1px solid rgba(220,38,38,0.2)',
          borderRadius: 8,
          color: '#DC2626',
          fontSize: 13,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button className="btn-ghost" onClick={loadMessages} style={{ color: '#DC2626' }}>Retry</button>
        </div>
      )}

      {/* Message list */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555' }}>
          <div className="spinner" /> Loading messages...
        </div>
      ) : messages.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: '#555' }}>
          No messages yet
        </div>
      ) : (
        <div>
          {messages.map((msg, i) => (
            <MessageCard key={msg.id || msg.message_id || i} message={msg} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && messages.length > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          marginTop: 20,
        }}>
          <button
            className="btn-ghost"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={{ opacity: page <= 1 ? 0.3 : 1 }}
          >
            <ChevronLeft size={16} />
          </button>
          <span style={{ fontSize: 13, color: '#888' }}>
            Page {page} of {totalPages}
          </span>
          <button
            className="btn-ghost"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            style={{ opacity: page >= totalPages ? 0.3 : 1 }}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
