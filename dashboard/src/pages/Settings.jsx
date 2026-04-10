import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Edit2,
  Check,
  X,
  Copy,
  RefreshCw,
  Zap,
  Phone,
  PhoneForwarded,
  PhoneCall,
  Calendar,
  Mail,
  Webhook,
  Download,
} from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import { getClients, createClient, updateClient, getHealth, getSettings } from '../lib/api';

const INITIAL_CLIENT = {
  business_name: '',
  owner_name: '',
  owner_phone: '',
  owner_email: '',
  industry: '',
  avg_ticket: '',
};

export default function Settings() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newClient, setNewClient] = useState({ ...INITIAL_CLIENT });
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editData, setEditData] = useState({});
  const [saving, setSaving] = useState(false);
  const [kbEditId, setKbEditId] = useState(null);
  const [kbText, setKbText] = useState('');
  const [kbError, setKbError] = useState('');
  const [health, setHealth] = useState({});
  const [copied, setCopied] = useState('');
  const [phoneSettings, setPhoneSettings] = useState({});

  const loadClients = useCallback(() => {
    setLoading(true);
    getClients()
      .then(data => {
        const list = Array.isArray(data) ? data : data.clients || [];
        setClients(list);
      })
      .catch(() => setClients([]))
      .finally(() => setLoading(false));
  }, []);

  const loadHealth = useCallback(() => {
    getHealth()
      .then(data => setHealth(data))
      .catch(() => setHealth({}));
  }, []);

  const loadPhoneSettings = useCallback(() => {
    const currentClient = localStorage.getItem('elyvn_client');
    if (!currentClient) return;
    getSettings(currentClient)
      .then(data => setPhoneSettings(data))
      .catch(() => setPhoneSettings({}));
  }, []);

  useEffect(() => {
    loadClients();
    loadHealth();
    loadPhoneSettings();
  }, [loadClients, loadHealth, loadPhoneSettings]);

  const handleCreate = async () => {
    if (!newClient.business_name) return;
    setCreating(true);
    try {
      await createClient({
        ...newClient,
        avg_ticket: newClient.avg_ticket ? Number(newClient.avg_ticket) : undefined,
      });
      setNewClient({ ...INITIAL_CLIENT });
      setShowAdd(false);
      loadClients();
    } catch {} finally {
      setCreating(false);
    }
  };

  const startEdit = (client) => {
    const id = client.id || client.client_id;
    setEditingId(id);
    setEditData({
      business_name: client.business_name || '',
      owner_name: client.owner_name || '',
      phone: client.phone || '',
      email: client.email || '',
      industry: client.industry || '',
      avg_ticket: client.avg_ticket || '',
      transfer_phone: client.transfer_phone || '',
      lead_webhook_url: client.lead_webhook_url || '',
      booking_webhook_url: client.booking_webhook_url || '',
      call_webhook_url: client.call_webhook_url || '',
      sms_webhook_url: client.sms_webhook_url || '',
      stage_change_webhook_url: client.stage_change_webhook_url || '',
    });
  };

  const handleSaveEdit = async () => {
    setSaving(true);
    try {
      await updateClient(editingId, {
        ...editData,
        avg_ticket: editData.avg_ticket ? Number(editData.avg_ticket) : undefined,
      });
      setEditingId(null);
      loadClients();
    } catch {} finally {
      setSaving(false);
    }
  };

  const startKbEdit = (client) => {
    const id = client.id || client.client_id;
    setKbEditId(id);
    setKbText(
      typeof client.knowledge_base === 'string'
        ? client.knowledge_base
        : JSON.stringify(client.knowledge_base || {}, null, 2)
    );
    setKbError('');
  };

  const saveKb = async () => {
    try {
      JSON.parse(kbText);
      setKbError('');
    } catch {
      setKbError('Invalid JSON');
      return;
    }
    try {
      await updateClient(kbEditId, { knowledge_base: JSON.parse(kbText) });
      setKbEditId(null);
      loadClients();
    } catch {}
  };

  const copyToClipboard = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 2000);
  };

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const integrations = [
    {
      name: 'Retell',
      key: 'retell',
      icon: Zap,
      color: '#3B82F6',
    },
    {
      name: 'Telnyx',
      key: 'telnyx',
      icon: Phone,
      color: '#DC2626',
    },
    {
      name: 'Cal.com',
      key: 'calcom',
      icon: Calendar,
      color: '#16A34A',
    },
    {
      name: 'SMTP',
      key: 'smtp',
      icon: Mail,
      color: '#EAB308',
    },
  ];

  return (
    <div className="fade-in">
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 28 }}>Settings</h1>

      {/* ========== CLIENT MANAGEMENT ========== */}
      <section style={{ marginBottom: 40 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Client Management</h2>
          <button
            className="btn-primary"
            onClick={() => setShowAdd(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <Plus size={14} /> Add Client
          </button>
        </div>

        {/* Add Client Form */}
        {showAdd && (
          <div className="card" style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600 }}>New Client</h3>
              <button className="btn-ghost" onClick={() => setShowAdd(false)}><X size={14} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {[
                { key: 'business_name', label: 'Business Name', placeholder: 'Acme Plumbing' },
                { key: 'owner_name', label: 'Owner Name', placeholder: 'John Doe' },
                { key: 'owner_phone', label: 'Phone', placeholder: '+15551234567' },
                { key: 'owner_email', label: 'Email', placeholder: 'owner@acme.com' },
                { key: 'industry', label: 'Industry', placeholder: 'Plumbing' },
                { key: 'avg_ticket', label: 'Avg Ticket ($)', placeholder: '250', type: 'number' },
              ].map(field => (
                <div key={field.key}>
                  <label style={{ fontSize: 11, color: '#555', display: 'block', marginBottom: 4 }}>
                    {field.label}
                  </label>
                  <input
                    type={field.type || 'text'}
                    value={newClient[field.key]}
                    onChange={e => setNewClient(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    style={{ width: '100%' }}
                  />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={creating || !newClient.business_name}
              >
                {creating ? 'Creating...' : 'Create Client'}
              </button>
            </div>
          </div>
        )}

        {/* Client List */}
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#555' }}>
            <div className="spinner" /> Loading clients...
          </div>
        ) : clients.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: '#555' }}>
            No clients yet. Add one to get started.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {clients.map(client => {
              const id = client.id || client.client_id;
              const isEditing = editingId === id;
              const isKbEdit = kbEditId === id;

              return (
                <div key={id} className="card" style={{ padding: 16 }}>
                  {isEditing ? (
                    /* Edit mode */
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                        {[
                          { key: 'name', label: 'Name' },
                          { key: 'owner_name', label: 'Owner' },
                          { key: 'phone', label: 'Phone' },
                          { key: 'email', label: 'Email' },
                          { key: 'industry', label: 'Industry' },
                          { key: 'avg_ticket', label: 'Avg Ticket', type: 'number' },
                          { key: 'transfer_phone', label: 'Transfer Phone', placeholder: '+15551234567' },
                        ].map(f => (
                          <div key={f.key}>
                            <label style={{ fontSize: 10, color: '#555', display: 'block', marginBottom: 2 }}>{f.label}</label>
                            <input
                              type={f.type || 'text'}
                              value={editData[f.key] || ''}
                              onChange={e => setEditData(prev => ({ ...prev, [f.key]: e.target.value }))}
                              style={{ width: '100%' }}
                            />
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop: 16 }}>
                        <h4 style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 8 }}>Outbound Webhook URLs</h4>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        {[
                          { key: 'lead_webhook_url', label: 'Lead Created', placeholder: 'https://hooks.zapier.com/...' },
                          { key: 'booking_webhook_url', label: 'Booking Created', placeholder: 'https://hooks.zapier.com/...' },
                          { key: 'call_webhook_url', label: 'Call Ended', placeholder: 'https://hooks.zapier.com/...' },
                          { key: 'sms_webhook_url', label: 'SMS Events', placeholder: 'https://hooks.zapier.com/...' },
                          { key: 'stage_change_webhook_url', label: 'Lead Stage Changed', placeholder: 'https://hooks.zapier.com/...' },
                        ].map(f => (
                          <div key={f.key}>
                            <label style={{ fontSize: 10, color: '#555', display: 'block', marginBottom: 2 }}>{f.label}</label>
                            <input
                              type={f.type || 'text'}
                              value={editData[f.key] || ''}
                              onChange={e => setEditData(prev => ({ ...prev, [f.key]: e.target.value }))}
                              style={{ width: '100%' }}
                            />
                          </div>
                        ))}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 12 }}>
                        <button className="btn-ghost" onClick={() => setEditingId(null)}>Cancel</button>
                        <button className="btn-primary" onClick={handleSaveEdit} disabled={saving}>
                          {saving ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* View mode */
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: client.active !== false ? '#16A34A' : '#555',
                          }} />
                          <span style={{ fontSize: 14, fontWeight: 600 }}>
                            {client.business_name}
                          </span>
                          {client.industry && (
                            <span style={{ fontSize: 11, color: '#555' }}>{client.industry}</span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn-ghost" onClick={() => startKbEdit(client)}>
                            Knowledge Base
                          </button>
                          <button className="btn-ghost" onClick={() => startEdit(client)}>
                            <Edit2 size={12} />
                          </button>
                        </div>
                      </div>
                      {(client.owner_name || client.email) && (
                        <div style={{ marginTop: 6, fontSize: 12, color: '#888' }}>
                          {client.owner_name && <span>{client.owner_name}</span>}
                          {client.owner_name && client.email && <span> &middot; </span>}
                          {client.email && <span>{client.email}</span>}
                        </div>
                      )}
                      {client.transfer_phone && (
                        <div style={{ marginTop: 4, fontSize: 12, color: '#888', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <PhoneForwarded size={11} />
                          <span>Transfer: {client.transfer_phone}</span>
                        </div>
                      )}

                      {/* Knowledge Base Editor */}
                      {isKbEdit && (
                        <div style={{ marginTop: 12 }}>
                          <label style={{ fontSize: 11, color: '#555', display: 'block', marginBottom: 4 }}>
                            Knowledge Base (JSON)
                          </label>
                          <textarea
                            value={kbText}
                            onChange={e => {
                              setKbText(e.target.value);
                              setKbError('');
                            }}
                            style={{
                              width: '100%',
                              minHeight: 160,
                              fontFamily: 'monospace',
                              fontSize: 12,
                              resize: 'vertical',
                            }}
                          />
                          {kbError && (
                            <div style={{ fontSize: 11, color: '#DC2626', marginTop: 4 }}>{kbError}</div>
                          )}
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
                            <button className="btn-ghost" onClick={() => setKbEditId(null)}>Cancel</button>
                            <button className="btn-primary" onClick={saveKb}>Save KB</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ========== PHONE NUMBER MANAGEMENT ========== */}
      {phoneSettings.phone && (
        <section style={{ marginBottom: 40 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Phone Number Management</h2>
          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <PhoneCall size={16} color="#C9A84C" />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e0d8c8' }}>Unified Phone Number</span>
                </div>
                <code style={{ fontSize: 15, color: '#C9A84C', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>
                  {phoneSettings.phone?.phone_number || 'Not provisioned'}
                </code>
                <div style={{ fontSize: 11, color: '#555' }}>
                  Single number for inbound calls + outbound SMS (SIP trunk to Retell)
                </div>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <PhoneForwarded size={16} color="#3B82F6" />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e0d8c8' }}>Call Transfer</span>
                </div>
                <code style={{ fontSize: 15, color: '#3B82F6', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>
                  {phoneSettings.voice?.transfer_phone || 'Not configured'}
                </code>
                <div style={{ fontSize: 11, color: '#555' }}>
                  Forwarding destination when callers request transfer or press *
                </div>
              </div>
            </div>
            {phoneSettings.voice && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #141414' }}>
                <div style={{ fontSize: 12, color: '#555', marginBottom: 8 }}>Voice Configuration</div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    Agent: <span style={{ color: '#e0d8c8' }}>{phoneSettings.voice.retell_agent_id ? 'Active' : 'Not set'}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    Voice: <span style={{ color: '#e0d8c8' }}>{phoneSettings.voice.retell_voice}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    Language: <span style={{ color: '#e0d8c8' }}>{phoneSettings.voice.retell_language}</span>
                  </div>
                </div>
              </div>
            )}
            <div style={{ marginTop: 12, fontSize: 11, color: '#555' }}>
              Phone numbers are provisioned via the Provision page. Edit transfer_phone in a client's settings above.
            </div>
          </div>
        </section>
      )}

      {/* ========== CONNECTION STATUS ========== */}
      <section style={{ marginBottom: 40 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Connection Status</h2>
          <button className="btn-ghost" onClick={loadHealth} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        <div className="grid-2">
          {integrations.map(intg => {
            // Map integration keys to env_configured keys from /health endpoint
            const envMap = {
              retell: 'RETELL_API_KEY',
              twilio: 'TWILIO_ACCOUNT_SID',
              calcom: 'CALCOM_API_KEY',
              smtp: 'ANTHROPIC_API_KEY', // SMTP uses IMAP_USER but fallback to a known key
            };
            const envKey = envMap[intg.key];
            const envConfigured = health?.env_configured || {};
            const isConnected = intg.key === 'twilio'
              ? !!(envConfigured.TWILIO_ACCOUNT_SID && envConfigured.TWILIO_AUTH_TOKEN)
              : !!envConfigured[envKey];
            const apiStatus = isConnected ? 'configured' : 'missing';
            const Icon = intg.icon;

            return (
              <div key={intg.key} className="card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <div style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: `${intg.color}15`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    <Icon size={16} color={intg.color} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{intg.name}</div>
                  </div>
                  <StatusBadge
                    status={isConnected ? 'connected' : 'error'}
                    type="status"
                  />
                </div>
                <div style={{ fontSize: 12, color: '#888', display: 'flex', alignItems: 'center', gap: 6 }}>
                  API Key:
                  <StatusBadge
                    status={apiStatus}
                    type="status"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ========== INBOUND WEBHOOK URLS ========== */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Inbound Webhook URLs</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { label: 'Retell Webhook', url: `${baseUrl}/webhooks/retell` },
            { label: 'Telnyx Webhook', url: `${baseUrl}/webhooks/telnyx` },
          ].map(wh => (
            <div key={wh.label} className="card" style={{
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ fontSize: 12, color: '#555', marginBottom: 2 }}>{wh.label}</div>
                <code style={{ fontSize: 13, color: '#e0d8c8', fontFamily: 'monospace' }}>{wh.url}</code>
              </div>
              <button
                className="btn-ghost"
                onClick={() => copyToClipboard(wh.url, wh.label)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
              >
                {copied === wh.label ? (
                  <><Check size={12} color="#16A34A" /> Copied</>
                ) : (
                  <><Copy size={12} /> Copy</>
                )}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ========== DATA EXPORT ========== */}
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Data Export</h2>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>
            Export leads, calls, and messages as CSV for Google Sheets or CRM import.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {clients.map(client => {
              const id = client.id || client.client_id;
              return (
                <a
                  key={id}
                  href={`${baseUrl}/api/exports/${id}/sheets?format=csv`}
                  download
                  className="btn-secondary"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, textDecoration: 'none' }}
                >
                  <Download size={12} />
                  {client.business_name || id.slice(0, 8)} (CSV)
                </a>
              );
            })}
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: '#555' }}>
            Tip: Use outbound webhook URLs (edit a client above) to push events to Zapier/Make for real-time Google Sheets sync.
          </div>
        </div>
      </section>
    </div>
  );
}
