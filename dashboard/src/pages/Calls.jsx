import { useState, useEffect, useCallback } from 'react';
import { Phone, PhoneForwarded, Clock, Target, TrendingUp, X, Search, ChevronLeft, ChevronRight, Filter, RefreshCw, ChevronDown } from 'lucide-react';
import { getCalls, getTranscript, transferCall } from '../lib/api';
import { useWebSocket } from '../lib/useWebSocket';
import { formatPhone, formatDuration, timeAgo } from '../lib/utils';

export default function Calls() {
  const clientId = localStorage.getItem('elyvn_client') || '';
  const apiKey = sessionStorage.getItem('elyvn_api_key') || '';
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedCall, setSelectedCall] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [activeCalls, setActiveCalls] = useState([]);
  const [transferring, setTransferring] = useState(null);

  // WebSocket integration
  const { isConnected, lastEvent } = useWebSocket(apiKey);

  // Filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [outcome, setOutcome] = useState('all');
  const [minScore, setMinScore] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');

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
      phone: phoneNumber || undefined,
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
  }, [clientId, page, startDate, endDate, outcome, minScore, phoneNumber]);

  useEffect(() => {
    loadCalls();
  }, [loadCalls]);

  // Listen for WebSocket updates
  useEffect(() => {
    if (!lastEvent) return;

    if (lastEvent.type === 'call_started') {
      setActiveCalls(prev => {
        if (prev.some(c => c.id === lastEvent.data?.id)) return prev;
        return [...prev, { id: lastEvent.data?.id, phone: lastEvent.data?.phone, direction: lastEvent.data?.direction, startedAt: new Date().toISOString() }];
      });
    }

    if (lastEvent.type === 'new_call') {
      // Call ended — remove from active, refresh list
      setActiveCalls(prev => prev.filter(c => c.id !== lastEvent.data?.id));
      setTimeout(() => loadCalls(), 500);
    }

    if (lastEvent.type === 'call_transfer') {
      setActiveCalls(prev => prev.map(c =>
        c.id === lastEvent.data?.id ? { ...c, status: 'transferring' } : c
      ));
      setTimeout(() => loadCalls(), 1000);
    }
  }, [lastEvent, loadCalls]);

  const handleTransfer = async (callId) => {
    if (!clientId || !callId) return;
    setTransferring(callId);
    try {
      await transferCall(clientId, callId);
    } catch (err) {
      console.error('[transfer]', err);
    } finally {
      setTransferring(null);
    }
  };

  const handleFilter = () => {
    setPage(1);
    loadCalls();
  };

  const clearFilters = () => {
    setStartDate('');
    setEndDate('');
    setOutcome('all');
    setMinScore('');
    setPhoneNumber('');
    setPage(1);
  };

  const openDetail = async (call) => {
    setSelectedCall(call);
    setTranscript(null);
    // Load transcript on demand
    if (call.id || call.call_id) {
      setTranscriptLoading(true);
      try {
        const data = await getTranscript(call.id || call.call_id);
        setTranscript(data);
      } catch (err) {
        setTranscript({ error: 'Failed to load transcript' });
      } finally {
        setTranscriptLoading(false);
      }
    }
  };

  const closeDetail = () => {
    setSelectedCall(null);
    setTranscript(null);
  };

  // Calculate stats from calls
  const stats = {
    totalCalls: Array.isArray(calls) ? calls.length : 0,
    avgDuration: Array.isArray(calls) && calls.length > 0 ? Math.round(calls.reduce((sum, c) => sum + (c.duration || 0), 0) / calls.length) : 0,
    bookingRate: Array.isArray(calls) && calls.length > 0 ? Math.round((calls.filter(c => c.outcome === 'booked').length / calls.length) * 100) : 0,
    avgScore: Array.isArray(calls) && calls.length > 0 ? (calls.reduce((sum, c) => sum + (c.score || 0), 0) / calls.length).toFixed(1) : 0,
  };

  const getOutcomeBadgeColor = (outcome) => {
    switch (outcome) {
      case 'booked':
        return { bg: 'rgba(34, 197, 94, 0.15)', color: '#22C55E', text: 'Booked' };
      case 'transferred':
        return { bg: 'rgba(59, 130, 246, 0.15)', color: '#3B82F6', text: 'Transferred' };
      case 'info_provided':
        return { bg: 'rgba(168, 85, 247, 0.15)', color: '#A855F7', text: 'Info Provided' };
      case 'missed':
        return { bg: 'rgba(239, 68, 68, 0.15)', color: '#EF4444', text: 'Missed' };
      default:
        return { bg: 'rgba(136, 136, 136, 0.15)', color: '#888', text: 'Unknown' };
    }
  };

  const getScoreBarColor = (score) => {
    if (score >= 8) return '#22C55E';
    if (score >= 5) return '#EAB308';
    return '#EF4444';
  };

  const getSentiment = (call) => {
    if (call.sentiment) return call.sentiment;
    if (call.score >= 8) return 'Positive';
    if (call.score >= 5) return 'Neutral';
    return 'Negative';
  };

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: '#e0d8c8' }}>Calls</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: isConnected ? '#22C55E' : '#EF4444' }}>
          <div style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: isConnected ? '#22C55E' : '#EF4444',
            boxShadow: isConnected ? '0 0 8px #22C55E' : 'none',
          }} />
          {isConnected ? 'Live Updates' : 'Disconnected'}
        </div>
      </div>

      {/* Stats Bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 32 }}>
        <div className="card" style={{ padding: 20, borderLeft: `4px solid #C9A84C` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Total Calls</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: '#e0d8c8' }}>{stats.totalCalls}</div>
            </div>
            <Phone size={24} style={{ color: '#C9A84C', opacity: 0.7 }} />
          </div>
        </div>

        <div className="card" style={{ padding: 20, borderLeft: `4px solid #C9A84C` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Avg Duration</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: '#e0d8c8' }}>{formatDuration(stats.avgDuration)}</div>
            </div>
            <Clock size={24} style={{ color: '#C9A84C', opacity: 0.7 }} />
          </div>
        </div>

        <div className="card" style={{ padding: 20, borderLeft: `4px solid #C9A84C` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Booking Rate</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: '#e0d8c8' }}>{stats.bookingRate}%</div>
            </div>
            <Target size={24} style={{ color: '#C9A84C', opacity: 0.7 }} />
          </div>
        </div>

        <div className="card" style={{ padding: 20, borderLeft: `4px solid #C9A84C` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Avg Score</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: '#e0d8c8' }}>{stats.avgScore}/10</div>
            </div>
            <TrendingUp size={24} style={{ color: '#C9A84C', opacity: 0.7 }} />
          </div>
        </div>
      </div>

      {/* Active Calls Banner */}
      {activeCalls.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#22C55E', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%', background: '#22C55E',
              animation: 'pulse 2s infinite',
            }} />
            {activeCalls.length} Active Call{activeCalls.length > 1 ? 's' : ''}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {activeCalls.map(ac => (
              <div key={ac.id} className="card" style={{
                padding: '12px 16px',
                borderLeft: `3px solid ${ac.status === 'transferring' ? '#3B82F6' : '#22C55E'}`,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                minWidth: 220,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#e0d8c8', fontFamily: 'monospace' }}>
                    {formatPhone(ac.phone)}
                  </div>
                  <div style={{ fontSize: 11, color: '#555' }}>
                    {ac.status === 'transferring' ? 'Transferring...' : ac.direction === 'outbound' ? 'Outbound' : 'Ringing'}
                    {' '}&middot; {timeAgo(ac.startedAt)}
                  </div>
                </div>
                <button
                  className="btn-ghost"
                  onClick={(e) => { e.stopPropagation(); handleTransfer(ac.id); }}
                  disabled={transferring === ac.id || ac.status === 'transferring'}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#3B82F6' }}
                  title="Transfer call"
                >
                  <PhoneForwarded size={14} />
                  {transferring === ac.id ? 'Transferring...' : 'Transfer'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters Card */}
      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Filter size={16} style={{ color: '#C9A84C' }} />
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e0d8c8' }}>Filters</h3>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
          <div>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>From Date</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: '#141414',
                border: '1px solid #222',
                borderRadius: 6,
                color: '#e0d8c8',
                fontSize: 13,
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>To Date</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: '#141414',
                border: '1px solid #222',
                borderRadius: 6,
                color: '#e0d8c8',
                fontSize: 13,
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>Outcome</label>
            <select
              value={outcome}
              onChange={e => setOutcome(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: '#141414',
                border: '1px solid #222',
                borderRadius: 6,
                color: '#e0d8c8',
                fontSize: 13,
              }}
            >
              <option value="all">All Outcomes</option>
              <option value="booked">Booked</option>
              <option value="transferred">Transferred</option>
              <option value="info_provided">Info Provided</option>
              <option value="missed">Missed</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>Min Score</label>
            <input
              type="number"
              min="1"
              max="10"
              value={minScore}
              onChange={e => setMinScore(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: '#141414',
                border: '1px solid #222',
                borderRadius: 6,
                color: '#e0d8c8',
                fontSize: 13,
              }}
              placeholder="1-10"
            />
          </div>
          <div>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>Phone Number</label>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                value={phoneNumber}
                onChange={e => setPhoneNumber(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  paddingLeft: '28px',
                  background: '#141414',
                  border: '1px solid #222',
                  borderRadius: 6,
                  color: '#e0d8c8',
                  fontSize: 13,
                }}
                placeholder="Search..."
              />
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#555' }} />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            className="btn-primary"
            onClick={handleFilter}
            aria-label="Apply call filters"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <RefreshCw size={14} />
            Apply Filters
          </button>
          <button
            className="btn-ghost"
            onClick={clearFilters}
            aria-label="Clear all filters"
          >
            Clear Filters
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(239, 68, 68, 0.15)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          borderRadius: 8,
          color: '#EF4444',
          fontSize: 13,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button className="btn-ghost" onClick={loadCalls} style={{ color: '#EF4444' }}>Retry</button>
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
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{
                borderBottom: '1px solid #141414',
                backgroundColor: 'transparent',
              }}>
                <th style={{
                  textAlign: 'left',
                  fontWeight: 600,
                  fontSize: 12,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  padding: '16px 20px',
                }}>Time</th>
                <th style={{
                  textAlign: 'left',
                  fontWeight: 600,
                  fontSize: 12,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  padding: '16px 20px',
                }}>Phone</th>
                <th style={{
                  textAlign: 'left',
                  fontWeight: 600,
                  fontSize: 12,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  padding: '16px 20px',
                }}>Duration</th>
                <th style={{
                  textAlign: 'left',
                  fontWeight: 600,
                  fontSize: 12,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  padding: '16px 20px',
                }}>Outcome</th>
                <th style={{
                  textAlign: 'left',
                  fontWeight: 600,
                  fontSize: 12,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  padding: '16px 20px',
                }}>Score</th>
                <th style={{
                  textAlign: 'left',
                  fontWeight: 600,
                  fontSize: 12,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  padding: '16px 20px',
                }}>Sentiment</th>
                <th style={{
                  textAlign: 'center',
                  fontWeight: 600,
                  fontSize: 12,
                  color: '#888',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  padding: '16px 20px',
                }}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call, i) => {
                const outcomeBadge = getOutcomeBadgeColor(call.outcome);
                const scoreColor = getScoreBarColor(call.score || 0);
                return (
                  <tr
                    key={call.id || call.call_id || i}
                    onClick={() => openDetail(call)}
                    style={{
                      borderBottom: '1px solid #0d0d0d',
                      cursor: 'pointer',
                      transition: 'background-color 0.2s',
                      backgroundColor: 'transparent',
                    }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = '#141414'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    <td style={{ padding: '16px 20px', fontSize: 13, color: '#e0d8c8', fontWeight: 500 }}>
                      {timeAgo(call.created_at || call.timestamp)}
                    </td>

                    <td style={{ padding: '16px 20px', fontSize: 13, color: '#e0d8c8', fontWeight: 500, fontFamily: 'monospace' }}>
                      {formatPhone(call.phone || call.phone_number)}
                    </td>

                    <td style={{ padding: '16px 20px', fontSize: 13, color: '#888' }}>
                      {formatDuration(call.duration || 0)}
                    </td>

                    <td style={{ padding: '16px 20px' }}>
                      <span style={{
                        display: 'inline-block',
                        padding: '4px 10px',
                        background: outcomeBadge.bg,
                        color: outcomeBadge.color,
                        borderRadius: 4,
                        fontSize: 12,
                        fontWeight: 600,
                      }}>
                        {outcomeBadge.text}
                      </span>
                    </td>

                    <td style={{ padding: '16px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{
                          width: 40,
                          height: 4,
                          background: '#0d0d0d',
                          borderRadius: 2,
                          overflow: 'hidden',
                        }}>
                          <div style={{
                            width: `${Math.min((call.score || 0) * 10, 100)}%`,
                            height: '100%',
                            background: scoreColor,
                          }} />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: scoreColor }}>
                          {(call.score || 0).toFixed(1)}
                        </span>
                      </div>
                    </td>

                    <td style={{ padding: '16px 20px', fontSize: 13, color: '#888' }}>
                      {getSentiment(call)}
                    </td>

                    <td style={{ padding: '16px 20px', textAlign: 'center', color: '#555' }}>
                      <ChevronDown size={16} aria-hidden="true" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {!loading && calls.length > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          marginTop: 24,
        }} role="navigation" aria-label="Call list pagination">
          <button
            className="btn-ghost"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            aria-label="Previous page"
            style={{ opacity: page <= 1 ? 0.3 : 1 }}
          >
            <ChevronLeft size={16} />
          </button>
          <span style={{ fontSize: 13, color: '#888' }} aria-live="polite">
            Page {page} of {totalPages}
          </span>
          <button
            className="btn-ghost"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            aria-label="Next page"
            style={{ opacity: page >= totalPages ? 0.3 : 1 }}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* Call Detail Modal */}
      {selectedCall && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          animation: 'fadeIn 0.2s',
        }}>
          <div className="card" style={{
            width: '90%',
            maxWidth: '600px',
            maxHeight: '90vh',
            overflow: 'auto',
            position: 'relative',
            padding: 0,
          }}>
            {/* Modal Header */}
            <div style={{
              padding: '24px 24px 16px',
              borderBottom: '1px solid #141414',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e0d8c8' }}>
                Call Details
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {activeCalls.some(ac => ac.id === (selectedCall.id || selectedCall.call_id)) && (
                  <button
                    className="btn-primary"
                    onClick={() => handleTransfer(selectedCall.id || selectedCall.call_id)}
                    disabled={transferring === (selectedCall.id || selectedCall.call_id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 12px' }}
                  >
                    <PhoneForwarded size={14} />
                    {transferring === (selectedCall.id || selectedCall.call_id) ? 'Transferring...' : 'Transfer Call'}
                  </button>
                )}
                <button
                  onClick={closeDetail}
                  aria-label="Close call details"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: '#888',
                    padding: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Modal Content */}
            <div style={{ padding: 24 }}>
              {/* Summary Section */}
              <div style={{ marginBottom: 24 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: '#888', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Summary
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Phone Number</div>
                    <div style={{ fontSize: 14, color: '#e0d8c8', fontWeight: 600, fontFamily: 'monospace' }}>
                      {formatPhone(selectedCall.phone || selectedCall.phone_number)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Duration</div>
                    <div style={{ fontSize: 14, color: '#e0d8c8', fontWeight: 600 }}>
                      {formatDuration(selectedCall.duration || 0)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Outcome</div>
                    <div style={{
                      display: 'inline-block',
                      padding: '4px 10px',
                      background: getOutcomeBadgeColor(selectedCall.outcome).bg,
                      color: getOutcomeBadgeColor(selectedCall.outcome).color,
                      borderRadius: 4,
                      fontSize: 13,
                      fontWeight: 600,
                    }}>
                      {getOutcomeBadgeColor(selectedCall.outcome).text}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Score</div>
                    <div style={{ fontSize: 14, color: '#e0d8c8', fontWeight: 600 }}>
                      {(selectedCall.score || 0).toFixed(1)} / 10
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Sentiment</div>
                    <div style={{ fontSize: 14, color: '#e0d8c8', fontWeight: 600 }}>
                      {getSentiment(selectedCall)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Time</div>
                    <div style={{ fontSize: 14, color: '#e0d8c8', fontWeight: 600 }}>
                      {new Date(selectedCall.created_at || selectedCall.timestamp).toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>

              {/* Transcript Section */}
              <div>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: '#888', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Transcript
                </h3>
                {transcriptLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555', justifyContent: 'center' }}>
                    <div className="spinner" /> Loading transcript...
                  </div>
                ) : transcript?.error ? (
                  <div style={{
                    padding: 16,
                    background: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid rgba(239, 68, 68, 0.2)',
                    borderRadius: 6,
                    color: '#EF4444',
                    fontSize: 13,
                    textAlign: 'center',
                  }}>
                    {transcript.error}
                  </div>
                ) : transcript?.transcript ? (
                  <>
                    <div style={{
                      padding: 16,
                      background: '#0d0d0d',
                      borderRadius: 6,
                      fontSize: 13,
                      lineHeight: 1.6,
                      color: '#e0d8c8',
                      maxHeight: 300,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordWrap: 'break-word',
                    }}>
                      {transcript.transcript}
                    </div>
                    <a
                      href={`/api/calls/${selectedCall.client_id}/${selectedCall.call_id}/transcript/download`}
                      download
                      style={{
                        display: 'inline-block',
                        marginTop: 8,
                        padding: '6px 14px',
                        background: '#c9a227',
                        color: '#0d0d0d',
                        borderRadius: 4,
                        fontSize: 12,
                        fontWeight: 600,
                        textDecoration: 'none',
                      }}
                    >
                      Download Transcript (.txt)
                    </a>
                  </>
                ) : (
                  <div style={{
                    padding: 16,
                    background: '#0d0d0d',
                    borderRadius: 6,
                    color: '#555',
                    fontSize: 13,
                    textAlign: 'center',
                  }}>
                    No transcript available
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
