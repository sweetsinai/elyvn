import { useState, useEffect, useCallback } from 'react';
import { X, Phone, MessageSquare, Search } from 'lucide-react';
import LeadCard from '../components/LeadCard';
import StatusBadge from '../components/StatusBadge';
import { getLeads, updateLeadStage, getCalls, getMessages } from '../lib/api';
import { formatPhone, timeAgo, truncate } from '../lib/utils';
import { useWebSocket } from '../lib/useWebSocket';

const STAGES = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];

const stageLabels = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  booked: 'Booked',
  completed: 'Completed',
  lost: 'Lost',
};

const stageColors = {
  new: '#60a5fa',
  contacted: '#fbbf24',
  qualified: '#D4AF37',
  booked: '#4ade80',
  completed: '#4ade80',
  lost: '#f87171',
};

export default function Pipeline() {
  const clientId = localStorage.getItem('elyvn_client') || '';
  const apiKey = sessionStorage.getItem('elyvn_api_key') || '';
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedLead, setSelectedLead] = useState(null);
  const [leadInteractions, setLeadInteractions] = useState([]);
  const [loadingInteractions, setLoadingInteractions] = useState(false);
  const [dragOverStage, setDragOverStage] = useState(null);

  // Search, filter, and pagination
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStage, setFilterStage] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // WebSocket integration
  const { isConnected, lastEvent } = useWebSocket(apiKey);

  const loadLeads = useCallback(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);

    getLeads(clientId, {
      page,
      limit: 20,
      stage: filterStage || undefined,
      search: searchQuery || undefined,
    })
      .then(data => {
        const list = Array.isArray(data) ? data : data.leads || [];
        setLeads(list);
        setTotalPages(data.total_pages || Math.ceil((data.total || list.length) / 20) || 1);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load leads');
        setLoading(false);
      });
  }, [clientId, page, filterStage, searchQuery]);

  useEffect(() => {
    loadLeads();
  }, [loadLeads]);

  // Listen for WebSocket updates (new calls/messages that might affect leads)
  useEffect(() => {
    if (lastEvent && (lastEvent.type === 'new_call' || lastEvent.type === 'new_message')) {
      // Refresh leads after a short delay to allow DB to update
      setTimeout(() => loadLeads(), 500);
    }
  }, [lastEvent, loadLeads]);

  const handleDrop = async (e, targetStage) => {
    e.preventDefault();
    setDragOverStage(null);
    try {
      const lead = JSON.parse(e.dataTransfer.getData('text/plain'));
      const leadId = lead.id || lead.lead_id;
      if (lead.stage === targetStage) return;

      // Optimistic update
      setLeads(prev => prev.map(l =>
        (l.id || l.lead_id) === leadId ? { ...l, stage: targetStage } : l
      ));

      await updateLeadStage(clientId, leadId, targetStage);
    } catch {
      loadLeads(); // Revert on error
    }
  };

  const openLeadDetail = async (lead) => {
    setSelectedLead(lead);
    setLoadingInteractions(true);
    try {
      const [callsData, msgsData] = await Promise.all([
        getCalls(clientId, { phone: lead.phone, limit: 10 }).catch(() => ({ calls: [] })),
        getMessages(clientId, { phone: lead.phone, limit: 10 }).catch(() => ({ messages: [] })),
      ]);
      const calls = (Array.isArray(callsData) ? callsData : callsData?.calls || []).map(c => ({ ...c, _type: 'call' }));
      const msgs = (Array.isArray(msgsData) ? msgsData : msgsData?.messages || []).map(m => ({ ...m, _type: 'message' }));
      const combined = [...calls, ...msgs].sort((a, b) => {
        const dateA = new Date(a.created_at || a.timestamp || 0);
        const dateB = new Date(b.created_at || b.timestamp || 0);
        return dateB - dateA;
      });
      setLeadInteractions(combined);
    } catch {
      setLeadInteractions([]);
    } finally {
      setLoadingInteractions(false);
    }
  };

  const getLeadsByStage = (stage) => leads.filter(l => l.stage === stage);

  if (loading) {
    return (
      <div className="fade-in">
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24, fontFamily: "'Cormorant Garamond', serif" }}>Pipeline</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#444' }}>
          <div className="spinner" /> Loading pipeline...
        </div>
      </div>
    );
  }

  const handleSearch = (query) => {
    setSearchQuery(query);
    setPage(1);
  };

  const handleFilterStage = (stage) => {
    setFilterStage(stage);
    setPage(1);
  };

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, fontFamily: "'Cormorant Garamond', serif" }}>Pipeline</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: isConnected ? '#4ade80' : '#f87171' }}>
          <div style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: isConnected ? '#4ade80' : '#f87171',
            boxShadow: isConnected ? '0 0 6px #4ade80' : 'none',
          }} />
          {isConnected ? 'Live Updates' : 'Disconnected'}
        </div>
      </div>

      {/* Search and Filter Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 24,
        padding: '12px 16px',
        background: 'rgba(255,255,255,0.03)',
        borderRadius: 14,
        border: '1px solid rgba(212,175,55,0.12)',
      }} role="search">
        <Search size={16} color="#444" aria-hidden="true" />
        <input
          type="text"
          placeholder="Search by name, phone, or email..."
          value={searchQuery}
          onChange={e => handleSearch(e.target.value)}
          aria-label="Search leads"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            color: '#F5F5F0',
            outline: 'none',
            fontSize: 13,
          }}
        />
        <select
          value={filterStage}
          onChange={e => handleFilterStage(e.target.value)}
          aria-label="Filter by pipeline stage"
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid rgba(212,175,55,0.15)',
            background: '#1a1a1a',
            color: '#F5F5F0',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          <option value="">All Stages</option>
          <option value="new">New</option>
          <option value="contacted">Contacted</option>
          <option value="qualified">Qualified</option>
          <option value="booked">Booked</option>
          <option value="completed">Completed</option>
          <option value="lost">Lost</option>
        </select>
      </div>

      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(248,113,113,0.1)',
          border: '1px solid rgba(248,113,113,0.2)',
          borderRadius: 14,
          color: '#f87171',
          fontSize: 13,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button className="btn-ghost" onClick={loadLeads} style={{ color: '#f87171' }}>Retry</button>
        </div>
      )}

      {/* Kanban Board */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${STAGES.length}, 1fr)`,
        gap: 10,
        minHeight: 500,
        overflowX: 'auto',
      }} role="group" aria-label="Pipeline kanban board">
        {STAGES.map(stage => {
          const stageLeads = getLeadsByStage(stage);
          return (
            <div
              key={stage}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverStage(stage);
              }}
              onDragLeave={() => setDragOverStage(null)}
              onDrop={(e) => handleDrop(e, stage)}
              aria-label={`${stageLabels[stage]} stage with ${stageLeads.length} leads`}
              style={{
                background: dragOverStage === stage ? 'rgba(212,175,55,0.05)' : 'transparent',
                border: `1px solid ${dragOverStage === stage ? 'rgba(212,175,55,0.2)' : 'rgba(212,175,55,0.12)'}`,
                borderRadius: 14,
                padding: 10,
                minWidth: 170,
                transition: 'all 0.15s',
              }}
            >
              {/* Column header */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
                padding: '0 2px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: stageColors[stage],
                  }} />
                  <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize', color: '#D4AF37' }}>
                    {stageLabels[stage]}
                  </span>
                </div>
                <span style={{
                  fontSize: 11,
                  color: '#444',
                  background: 'rgba(212,175,55,0.08)',
                  padding: '1px 6px',
                  borderRadius: 6,
                }}>
                  {stageLeads.length}
                </span>
              </div>

              {/* Lead cards */}
              {stageLeads.length === 0 ? (
                <div style={{ fontSize: 11, color: '#333', textAlign: 'center', padding: 20 }}>
                  Drop leads here
                </div>
              ) : (
                stageLeads.map((lead, i) => (
                  <LeadCard
                    key={lead.id || lead.lead_id || i}
                    lead={lead}
                    onDragStart={() => {}}
                    onClick={openLeadDetail}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          marginTop: 24,
          paddingTop: 16,
          borderTop: '1px solid rgba(212,175,55,0.12)',
        }} role="navigation" aria-label="Lead list pagination">
          <button
            className="btn-ghost"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            aria-label="Previous page"
            style={{ opacity: page <= 1 ? 0.3 : 1 }}
          >
            Previous
          </button>
          <span style={{ fontSize: 13, color: '#666', minWidth: 100, textAlign: 'center' }} aria-live="polite">
            Page {page} of {totalPages}
          </span>
          <button
            className="btn-ghost"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            aria-label="Next page"
            style={{ opacity: page >= totalPages ? 0.3 : 1 }}
          >
            Next
          </button>
        </div>
      )}

      {/* Lead Detail Modal */}
      {selectedLead && (
        <div className="modal-overlay" onClick={() => setSelectedLead(null)}>
          <div
            className="modal-content"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 520, borderRadius: 24, backdropFilter: 'blur(20px)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>
                {selectedLead.name || formatPhone(selectedLead.phone)}
              </h3>
              <button className="btn-ghost" onClick={() => setSelectedLead(null)} aria-label="Close lead details">
                <X size={16} />
              </button>
            </div>

            {/* Lead info */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 11, color: '#444', marginBottom: 2 }}>Phone</div>
                <div style={{ fontSize: 13 }}>{formatPhone(selectedLead.phone)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#444', marginBottom: 2 }}>Email</div>
                <div style={{ fontSize: 13 }}>{selectedLead.email || '--'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#444', marginBottom: 2 }}>Score</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{selectedLead.score != null ? (selectedLead.score <= 10 ? selectedLead.score * 10 : selectedLead.score) : '--'}/100</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#444', marginBottom: 2 }}>Stage</div>
                <StatusBadge status={selectedLead.stage} type="stage" />
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#444', marginBottom: 2 }}>Source</div>
                <div style={{ fontSize: 13, textTransform: 'capitalize' }}>{selectedLead.source || '--'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#444', marginBottom: 2 }}>Last Contact</div>
                <div style={{ fontSize: 13 }}>{timeAgo(selectedLead.last_interaction)}</div>
              </div>
            </div>

            {/* Follow-up info */}
            {selectedLead.follow_ups && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Follow-up Status</div>
                <div style={{ fontSize: 12, color: '#666' }}>
                  Touches sent: {selectedLead.follow_ups?.sent || 0} | Scheduled: {selectedLead.follow_ups?.scheduled || 0}
                </div>
              </div>
            )}

            {/* Notes */}
            {selectedLead.notes && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Notes</div>
                <div style={{ fontSize: 13, color: '#666', lineHeight: 1.6 }}>{selectedLead.notes}</div>
              </div>
            )}

            {/* Interactions */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Recent Interactions</div>
              {loadingInteractions ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#444', fontSize: 12 }}>
                  <div className="spinner" /> Loading...
                </div>
              ) : leadInteractions.length === 0 ? (
                <div style={{ fontSize: 12, color: '#444' }}>No interactions found</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                  {leadInteractions.map((item, i) => (
                    <div key={i} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      background: '#050505',
                      borderRadius: 10,
                      fontSize: 12,
                    }}>
                      {item._type === 'call' ? <Phone size={12} color="#60a5fa" /> : <MessageSquare size={12} color="#D4AF37" />}
                      <span style={{ color: '#666', minWidth: 54 }}>{timeAgo(item.created_at)}</span>
                      <span style={{ flex: 1, color: '#F5F5F0' }} className="truncate">
                        {item._type === 'call'
                          ? truncate(item.summary || item.outcome || 'Call', 40)
                          : truncate(item.original_message || item.body || 'Message', 40)
                        }
                      </span>
                      <StatusBadge
                        status={item.outcome || item.status}
                        type={item._type === 'call' ? 'outcome' : 'status'}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
