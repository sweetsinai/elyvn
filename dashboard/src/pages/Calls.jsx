import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import CallCard from '../components/CallCard';
import { getCalls } from '../lib/api';

export default function Calls() {
  const clientId = localStorage.getItem('elyvn_client') || '';
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [outcome, setOutcome] = useState('all');
  const [minScore, setMinScore] = useState('');

  const loadCalls = useCallback(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);

    getCalls(clientId, {
      page,
      limit: 20,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      outcome: outcome === 'all' ? undefined : outcome,
      minScore: minScore || undefined,
    })
      .then(data => {
        const list = Array.isArray(data) ? data : data.calls || [];
        setCalls(list);
        setTotalPages(data.total_pages || Math.ceil((data.total || list.length) / 20) || 1);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load calls');
        setLoading(false);
      });
  }, [clientId, page, startDate, endDate, outcome, minScore]);

  useEffect(() => {
    loadCalls();
  }, [loadCalls]);

  const handleFilter = () => {
    setPage(1);
    loadCalls();
  };

  return (
    <div className="fade-in">
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Calls</h1>

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
        <select value={outcome} onChange={e => setOutcome(e.target.value)}>
          <option value="all">All Outcomes</option>
          <option value="booked">Booked</option>
          <option value="transferred">Transferred</option>
          <option value="info_provided">Info Provided</option>
          <option value="missed">Missed</option>
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#555' }}>Min Score</label>
          <input
            type="number"
            min="1"
            max="10"
            value={minScore}
            onChange={e => setMinScore(e.target.value)}
            style={{ width: 60 }}
            placeholder="1-10"
          />
        </div>
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
          <button className="btn-ghost" onClick={loadCalls} style={{ color: '#DC2626' }}>Retry</button>
        </div>
      )}

      {/* Call list */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555' }}>
          <div className="spinner" /> Loading calls...
        </div>
      ) : calls.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: '#555' }}>
          No calls yet
        </div>
      ) : (
        <div>
          {calls.map((call, i) => (
            <CallCard key={call.id || call.call_id || i} call={call} clientId={clientId} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && calls.length > 0 && (
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
