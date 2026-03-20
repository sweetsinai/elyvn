import { useState, useEffect, useCallback } from 'react';
import { Search, Send, RefreshCw, Edit2, Check, X, ChevronDown, ChevronUp } from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import {
  scrapeBusinesses,
  getCampaigns,
  createCampaign,
  generateEmails,
  sendCampaign,
  getReplies,
  classifyReply,
} from '../lib/api';

const TABS = ['Scrape', 'Campaigns', 'Replies'];

export default function Outreach() {
  const [activeTab, setActiveTab] = useState('Scrape');

  return (
    <div className="fade-in">
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Outreach</h1>

      {/* Tabs */}
      <div style={{
        display: 'flex',
        gap: 0,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        marginBottom: 24,
      }}>
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '10px 20px',
              fontSize: 13,
              fontWeight: activeTab === tab ? 600 : 400,
              color: activeTab === tab ? '#C9A84C' : '#888',
              background: 'transparent',
              borderBottom: activeTab === tab ? '2px solid #C9A84C' : '2px solid transparent',
              transition: 'all 0.15s',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Scrape' && <ScrapeTab />}
      {activeTab === 'Campaigns' && <CampaignsTab />}
      {activeTab === 'Replies' && <RepliesTab />}
    </div>
  );
}

/* ============ SCRAPE TAB ============ */
function ScrapeTab() {
  const [industry, setIndustry] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('US');
  const [maxResults, setMaxResults] = useState(50);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState(null);

  const handleScrape = async () => {
    if (!industry || !city) return;
    setLoading(true);
    setError(null);
    try {
      const data = await scrapeBusinesses({ industry, city, country, maxResults });
      const list = Array.isArray(data) ? data : data.prospects || data.businesses || data.results || [];
      setResults(list);
      setSelected(new Set());
    } catch (err) {
      setError(err.message || 'Scrape failed');
    } finally {
      setLoading(false);
    }
  };

  const toggleAll = () => {
    if (selected.size === results.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(results.map((_, i) => i)));
    }
  };

  const toggleOne = (i) => {
    const next = new Set(selected);
    next.has(i) ? next.delete(i) : next.add(i);
    setSelected(next);
  };

  return (
    <div>
      {/* Form */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={{ fontSize: 11, color: '#555', display: 'block', marginBottom: 4 }}>Industry</label>
          <input
            value={industry}
            onChange={e => setIndustry(e.target.value)}
            placeholder="e.g. Plumbing"
            style={{ width: 180 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: '#555', display: 'block', marginBottom: 4 }}>City</label>
          <input
            value={city}
            onChange={e => setCity(e.target.value)}
            placeholder="e.g. Austin"
            style={{ width: 160 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: '#555', display: 'block', marginBottom: 4 }}>Country</label>
          <select value={country} onChange={e => setCountry(e.target.value)}>
            <option value="US">US</option>
            <option value="UK">UK</option>
            <option value="CA">CA</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: '#555', display: 'block', marginBottom: 4 }}>Max Results</label>
          <input
            type="number"
            value={maxResults}
            onChange={e => setMaxResults(Number(e.target.value))}
            style={{ width: 80 }}
          />
        </div>
        <button
          className="btn-primary"
          onClick={handleScrape}
          disabled={loading || !industry || !city}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {loading ? <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <Search size={14} />}
          {loading ? 'Scraping...' : 'Scrape Businesses'}
        </button>
      </div>

      {error && (
        <div style={{
          padding: '10px 14px',
          background: 'rgba(220,38,38,0.1)',
          borderRadius: 6,
          color: '#DC2626',
          fontSize: 13,
          marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {/* Results table */}
      {results.length > 0 && (
        <div className="card" style={{ overflow: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={selected.size === results.length && results.length > 0}
                    onChange={toggleAll}
                    style={{ padding: 0, width: 14, height: 14, cursor: 'pointer' }}
                  />
                </th>
                <th>Business Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Rating</th>
                <th>Reviews</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((biz, i) => (
                <tr key={i}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => toggleOne(i)}
                      style={{ padding: 0, width: 14, height: 14, cursor: 'pointer' }}
                    />
                  </td>
                  <td style={{ fontWeight: 500 }}>{biz.business_name}</td>
                  <td style={{ color: '#888' }}>{biz.phone || '--'}</td>
                  <td style={{ color: biz.email ? '#888' : '#555' }}>{biz.email || 'Not found'}</td>
                  <td style={{ color: '#C9A84C' }}>{biz.rating || '--'}</td>
                  <td style={{ color: '#888' }}>{biz.reviews ?? biz.review_count ?? '--'}</td>
                  <td><StatusBadge status={biz.status || 'new'} type="stage" /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '10px 12px', fontSize: 12, color: '#555' }}>
            {selected.size} of {results.length} selected
          </div>
        </div>
      )}
    </div>
  );
}

/* ============ CAMPAIGNS TAB ============ */
function CampaignsTab() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [emails, setEmails] = useState({});
  const [editingEmail, setEditingEmail] = useState(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [generatingId, setGeneratingId] = useState(null);
  const [sendingId, setSendingId] = useState(null);
  const [confirmSend, setConfirmSend] = useState(null);

  const loadCampaigns = useCallback(() => {
    setLoading(true);
    getCampaigns()
      .then(data => {
        const list = Array.isArray(data) ? data : data.campaigns || [];
        setCampaigns(list);
      })
      .catch(() => setCampaigns([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  const handleCreate = async () => {
    if (!newName) return;
    setCreating(true);
    try {
      await createCampaign({ name: newName });
      setNewName('');
      setShowNew(false);
      loadCampaigns();
    } catch {} finally {
      setCreating(false);
    }
  };

  const handleGenerate = async (campaignId) => {
    setGeneratingId(campaignId);
    try {
      const data = await generateEmails(campaignId);
      const list = Array.isArray(data) ? data : data.emails || [];
      setEmails(prev => ({ ...prev, [campaignId]: list }));
      setExpandedId(campaignId);
    } catch {} finally {
      setGeneratingId(null);
    }
  };

  const handleSend = async (campaignId) => {
    setSendingId(campaignId);
    setConfirmSend(null);
    try {
      await sendCampaign(campaignId);
      loadCampaigns();
    } catch {} finally {
      setSendingId(null);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555' }}>
        <div className="spinner" /> Loading campaigns...
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: '#888' }}>{campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''}</span>
        <button className="btn-primary" onClick={() => setShowNew(true)}>
          New Campaign
        </button>
      </div>

      {/* New Campaign Form */}
      {showNew && (
        <div className="card" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Campaign name..."
            style={{ flex: 1 }}
            autoFocus
          />
          <button className="btn-primary" onClick={handleCreate} disabled={creating || !newName}>
            {creating ? 'Creating...' : 'Create'}
          </button>
          <button className="btn-ghost" onClick={() => setShowNew(false)}><X size={14} /></button>
        </div>
      )}

      {/* Campaign List */}
      {campaigns.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: '#555' }}>
          No campaigns yet. Create one to get started.
        </div>
      ) : (
        campaigns.map(campaign => {
          const id = campaign.id || campaign.campaign_id;
          const isExpanded = expandedId === id;
          const campaignEmails = emails[id] || [];

          return (
            <div key={id} className="card" style={{ marginBottom: 8 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '14px 16px',
                  cursor: 'pointer',
                }}
                onClick={() => setExpandedId(isExpanded ? null : id)}
              >
                <span style={{ flex: 1, fontWeight: 500, fontSize: 13 }}>{campaign.name}</span>
                <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#888' }}>
                  <span>Sent: {campaign.sent || 0}</span>
                  <span>Replied: {campaign.replied || 0}</span>
                  <span style={{ color: '#16A34A' }}>Booked: {campaign.booked || 0}</span>
                </div>
                {isExpanded ? <ChevronUp size={14} color="#555" /> : <ChevronDown size={14} color="#555" />}
              </div>

              {isExpanded && (
                <div style={{ padding: '0 16px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, marginBottom: 12 }}>
                    <button
                      className="btn-secondary"
                      onClick={() => handleGenerate(id)}
                      disabled={generatingId === id}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      {generatingId === id ? (
                        <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                      ) : (
                        <RefreshCw size={12} />
                      )}
                      {generatingId === id ? 'Generating...' : 'Generate Emails'}
                    </button>
                    <button
                      className="btn-primary"
                      onClick={() => setConfirmSend(id)}
                      disabled={sendingId === id}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      {sendingId === id ? (
                        <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                      ) : (
                        <Send size={12} />
                      )}
                      {sendingId === id ? 'Sending...' : 'Send Campaign'}
                    </button>
                  </div>

                  {/* Sending progress */}
                  {sendingId === id && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{
                        height: 4,
                        background: 'rgba(255,255,255,0.06)',
                        borderRadius: 2,
                        overflow: 'hidden',
                      }}>
                        <div style={{
                          height: '100%',
                          background: '#C9A84C',
                          borderRadius: 2,
                          width: '60%',
                          animation: 'progress 2s ease-in-out infinite',
                        }} />
                      </div>
                    </div>
                  )}

                  {/* Email previews */}
                  {campaignEmails.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {campaignEmails.map((email, i) => (
                        <div key={i} style={{
                          padding: 12,
                          background: '#050505',
                          borderRadius: 6,
                        }}>
                          {editingEmail === `${id}-${i}` ? (
                            <div>
                              <input
                                value={editSubject}
                                onChange={e => setEditSubject(e.target.value)}
                                style={{ width: '100%', marginBottom: 8 }}
                                placeholder="Subject"
                              />
                              <textarea
                                value={editBody}
                                onChange={e => setEditBody(e.target.value)}
                                style={{ width: '100%', minHeight: 80, resize: 'vertical' }}
                              />
                              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                                <button
                                  className="btn-primary"
                                  onClick={() => {
                                    const updated = [...campaignEmails];
                                    updated[i] = { ...updated[i], subject: editSubject, body: editBody };
                                    setEmails(prev => ({ ...prev, [id]: updated }));
                                    setEditingEmail(null);
                                  }}
                                >
                                  <Check size={12} /> Save
                                </button>
                                <button className="btn-ghost" onClick={() => setEditingEmail(null)}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <div style={{ fontSize: 13, fontWeight: 500 }}>{email.subject || `Email ${i + 1}`}</div>
                                <button
                                  className="btn-ghost"
                                  onClick={() => {
                                    setEditingEmail(`${id}-${i}`);
                                    setEditSubject(email.subject || '');
                                    setEditBody(email.body || '');
                                  }}
                                >
                                  <Edit2 size={12} />
                                </button>
                              </div>
                              <div style={{ fontSize: 12, color: '#888', marginTop: 4, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                                {email.body || 'No body'}
                              </div>
                              {email.to && (
                                <div style={{ fontSize: 11, color: '#555', marginTop: 6 }}>To: {email.to}</div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Confirmation Dialog */}
      {confirmSend && (
        <div className="modal-overlay" onClick={() => setConfirmSend(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Confirm Send</h3>
            <p style={{ fontSize: 13, color: '#888', marginBottom: 20 }}>
              Are you sure you want to send this campaign? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setConfirmSend(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => handleSend(confirmSend)}>
                <Send size={12} style={{ marginRight: 4 }} /> Send Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============ REPLIES TAB ============ */
function RepliesTab() {
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [classifyingId, setClassifyingId] = useState(null);

  const loadReplies = useCallback(() => {
    setLoading(true);
    getReplies()
      .then(data => {
        const list = Array.isArray(data) ? data : data.replies || [];
        setReplies(list);
      })
      .catch(() => setReplies([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadReplies(); }, [loadReplies]);

  const handleReclassify = async (emailId) => {
    setClassifyingId(emailId);
    try {
      const result = await classifyReply(emailId);
      setReplies(prev => prev.map(r =>
        (r.id || r.email_id) === emailId
          ? { ...r, classification: result.classification || r.classification }
          : r
      ));
    } catch {} finally {
      setClassifyingId(null);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555' }}>
        <div className="spinner" /> Loading replies...
      </div>
    );
  }

  if (replies.length === 0) {
    return (
      <div className="card" style={{ padding: 40, textAlign: 'center', color: '#555' }}>
        No replies yet
      </div>
    );
  }

  return (
    <div className="card" style={{ overflow: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>Prospect</th>
            <th>Reply</th>
            <th>Classification</th>
            <th>Auto-Response</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {replies.map((reply, i) => {
            const id = reply.id || reply.email_id;
            const isExpanded = expandedIdx === i;
            return (
              <>
                <tr
                  key={id || i}
                  onClick={() => setExpandedIdx(isExpanded ? null : i)}
                  style={{ cursor: 'pointer' }}
                >
                  <td style={{ fontWeight: 500 }}>{reply.prospect_name || reply.from || '--'}</td>
                  <td style={{ color: '#888', maxWidth: 280 }} className="truncate">
                    {reply.reply_text || reply.body || '--'}
                  </td>
                  <td>
                    <StatusBadge status={reply.classification} type="classification" />
                  </td>
                  <td style={{ color: reply.auto_responded ? '#16A34A' : '#555' }}>
                    {reply.auto_responded ? 'Yes' : 'No'}
                  </td>
                  <td>
                    <button
                      className="btn-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReclassify(id);
                      }}
                      disabled={classifyingId === id}
                      style={{ fontSize: 11 }}
                    >
                      {classifyingId === id ? 'Classifying...' : 'Reclassify'}
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr key={`${id}-detail`}>
                    <td colSpan={5} style={{ padding: 16, background: '#050505' }}>
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, color: '#555', textTransform: 'uppercase', marginBottom: 4 }}>
                          Full Reply
                        </div>
                        <div style={{ fontSize: 13, color: '#e0d8c8', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                          {reply.reply_text || reply.body || 'N/A'}
                        </div>
                      </div>
                      {reply.response && (
                        <div>
                          <div style={{ fontSize: 11, color: '#555', textTransform: 'uppercase', marginBottom: 4 }}>
                            Auto-Response Sent
                          </div>
                          <div style={{ fontSize: 13, color: '#888', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                            {reply.response}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
