import { useState, useEffect, useCallback } from 'react';
import { X, Phone, MessageSquare } from 'lucide-react';
import LeadCard from '../components/LeadCard';
import StatusBadge from '../components/StatusBadge';
import { getLeads, updateLeadStage, getCalls, getMessages } from '../lib/api';
import { formatPhone, timeAgo, truncate } from '../lib/utils';

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
  new: '#3B82F6',
  contacted: '#EAB308',
  qualified: '#C9A84C',
  booked: '#16A34A',
  completed: '#16A34A',
  lost: '#DC2626',
};

export default function Pipeline() {
  const clientId = localStorage.getItem('elyvn_client') || '';
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedLead, setSelectedLead] = useState(null);
  const [leadInteractions, setLeadInteractions] = useState([]);
  const [loadingInteractions, setLoadingInteractions] = useState(false);
  const [dragOverStage, setDragOverStage] = useState(null);

  const loadLeads = useCallback(() => {
    if (!clientId) return;
    setLoading(true);
    setError(null);

    getLeads(clientId)
      .then(data => {
        const list = Array.isArray(data) ? data : data.leads || [];
        setLeads(list);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load leads');
        setLoading(false);
      });
  }, [clientId]);

  useEffect(() => {
    loadLeads();
  }, [loadLeads]);

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
      const calls = (Array.isArray(callsData) ? callsData : callsData.calls || []).map(c => ({ ...c, _type: 'call' }));
      const msgs = (Array.isArray(msgsData) ? msgsData : msgsData.messages || []).map(m => ({ ...m, _type: 'message' }));
      const combined = [...calls, ...msgs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Pipeline</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555' }}>
          <div className="spinner" /> Loading pipeline...
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Pipeline</h1>

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
          <button className="btn-ghost" onClick={loadLeads} style={{ color: '#DC2626' }}>Retry</button>
        </div>
      )}

      {/* Kanban Board */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${STAGES.length}, 1fr)`,
        gap: 10,
        minHeight: 500,
        overflowX: 'auto',
      }}>
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
              style={{
                background: dragOverStage === stage ? 'rgba(201,168,76,0.05)' : 'transparent',
                border: `1px solid ${dragOverStage === stage ? 'rgba(201,168,76,0.2)' : 'rgba(255,255,255,0.06)'}`,
                borderRadius: 8,
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
                  <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>
                    {stageLabels[stage]}
                  </span>
                </div>
                <span style={{
                  fontSize: 11,
                  color: '#555',
                  background: 'rgba(255,255,255,0.04)',
                  padding: '1px 6px',
                  borderRadius: 4,
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

      {/* Lead Detail Modal */}
      {selectedLead && (
        <div className="modal-overlay" onClick={() => setSelectedLead(null)}>
          <div
            className="modal-content"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 520 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>
                {selectedLead.name || formatPhone(selectedLead.phone)}
              </h3>
              <button className="btn-ghost" onClick={() => setSelectedLead(null)}>
                <X size={16} />
              </button>
            </div>

            {/* Lead info */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 11, color: '#555', marginBottom: 2 }}>Phone</div>
                <div style={{ fontSize: 13 }}>{formatPhone(selectedLead.phone)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#555', marginBottom: 2 }}>Email</div>
                <div style={{ fontSize: 13 }}>{selectedLead.email || '--'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#555', marginBottom: 2 }}>Score</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{selectedLead.score ?? '--'}/10</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#555', marginBottom: 2 }}>Stage</div>
                <StatusBadge status={selectedLead.stage} type="stage" />
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#555', marginBottom: 2 }}>Source</div>
                <div style={{ fontSize: 13, textTransform: 'capitalize' }}>{selectedLead.source || '--'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#555', marginBottom: 2 }}>Last Contact</div>
                <div style={{ fontSize: 13 }}>{timeAgo(selectedLead.last_interaction)}</div>
              </div>
            </div>

            {/* Follow-up info */}
            {selectedLead.follow_ups && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Follow-up Status</div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  Touches sent: {selectedLead.follow_ups?.sent || 0} | Scheduled: {selectedLead.follow_ups?.scheduled || 0}
                </div>
              </div>
            )}

            {/* Notes */}
            {selectedLead.notes && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Notes</div>
                <div style={{ fontSize: 13, color: '#888', lineHeight: 1.6 }}>{selectedLead.notes}</div>
              </div>
            )}

            {/* Interactions */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Recent Interactions</div>
              {loadingInteractions ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#555', fontSize: 12 }}>
                  <div className="spinner" /> Loading...
                </div>
              ) : leadInteractions.length === 0 ? (
                <div style={{ fontSize: 12, color: '#555' }}>No interactions found</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                  {leadInteractions.map((item, i) => (
                    <div key={i} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      background: '#050505',
                      borderRadius: 6,
                      fontSize: 12,
                    }}>
                      {item._type === 'call' ? <Phone size={12} color="#3B82F6" /> : <MessageSquare size={12} color="#C9A84C" />}
                      <span style={{ color: '#888', minWidth: 54 }}>{timeAgo(item.created_at)}</span>
                      <span style={{ flex: 1, color: '#e0d8c8' }} className="truncate">
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
