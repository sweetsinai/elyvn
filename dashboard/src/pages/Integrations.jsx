import { useState, useEffect, useCallback } from 'react';
import {
  Webhook,
  Send,
  RefreshCw,
  Check,
  X,
  Copy,
  ExternalLink,
  AlertTriangle,
  Clock,
  Zap,
  Phone,
  Calendar,
  MessageSquare,
  Mail,
  PhoneForwarded,
  FileSpreadsheet,
  Brain,
} from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import { getWebhookLog, testWebhook, getIntegrationStatus, getHealth } from '../lib/api';

const EVENT_TYPES = [
  { value: 'call_ended', label: 'Call Ended' },
  { value: 'lead.created', label: 'Lead Created' },
  { value: 'lead.stage_changed', label: 'Lead Stage Changed' },
  { value: 'sms.received', label: 'SMS Received' },
  { value: 'sms.sent', label: 'SMS Sent' },
  { value: 'booking.created', label: 'Booking Created' },
];

export default function Integrations() {
  const clientId = localStorage.getItem('elyvn_client') || '';
  const [integrations, setIntegrations] = useState(null);
  const [webhookLog, setWebhookLog] = useState([]);
  const [logLoading, setLogLoading] = useState(true);
  const [health, setHealth] = useState({});
  const [testEvent, setTestEvent] = useState('call_ended');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [copied, setCopied] = useState('');

  const loadData = useCallback(() => {
    if (!clientId) return;

    setLogLoading(true);
    Promise.all([
      getIntegrationStatus(clientId).catch(() => null),
      getWebhookLog(clientId).catch(() => ({ log: [] })),
      getHealth().catch(() => ({})),
    ]).then(([status, log, h]) => {
      setIntegrations(status);
      setWebhookLog(log?.log || []);
      setHealth(h);
      setLogLoading(false);
    });
  }, [clientId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testWebhook(clientId, testEvent);
      setTestResult({ ok: true, message: `Test ${testEvent} sent to ${result.url}` });
      setTimeout(() => loadData(), 2000);
    } catch (err) {
      setTestResult({ ok: false, message: err.message || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const copyToClipboard = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 2000);
  };

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const serviceCards = [
    { name: 'Retell AI', key: 'retell', icon: Zap, color: '#60a5fa', desc: 'Voice AI agent' },
    { name: 'Twilio', key: 'twilio', icon: Phone, color: '#f87171', desc: 'SMS & calls' },
    { name: 'Cal.com', key: 'calcom', icon: Calendar, color: '#4ade80', desc: 'Appointment booking' },
    { name: 'Telegram', key: 'telegram', icon: MessageSquare, color: '#0088CC', desc: 'Owner notifications' },
    { name: 'SMTP', key: 'smtp', icon: Mail, color: '#fbbf24', desc: 'Email outreach' },
    { name: 'Call Transfer', key: 'transfer', icon: PhoneForwarded, color: '#A855F7', desc: 'Forward to owner' },
    { name: 'Managed Agents (MCP)', key: 'mcp', icon: Brain, color: '#D4AF37', desc: 'Multi-agent system' },
  ];

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 300, fontFamily: "'Cormorant Garamond', Georgia, serif" }}>Integrations</h1>
        <button className="btn-ghost" onClick={loadData} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* ========== CONNECTION STATUS GRID ========== */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Service Status</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          {serviceCards.map(svc => {
            const data = integrations?.[svc.key];
            const isUp = data?.configured === true;
            const Icon = svc.icon;

            return (
              <div key={svc.key} className="card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 14,
                    background: `${svc.color}15`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Icon size={16} color={svc.color} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{svc.name}</div>
                    <div style={{ fontSize: 11, color: '#444' }}>{svc.desc}</div>
                  </div>
                </div>
                <StatusBadge
                  status={isUp ? 'connected' : 'error'}
                  type="status"
                />
              </div>
            );
          })}
        </div>
      </section>

      {/* ========== WEBHOOK CONFIGURATION ========== */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Webhook URLs</h2>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>Inbound (set these in external dashboards)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { label: 'Retell Webhook', url: `${baseUrl}/webhooks/retell` },
                { label: 'Twilio Webhook', url: `${baseUrl}/webhooks/twilio` },
                { label: 'Twilio Webhook (Secondary)', url: `${baseUrl}/webhooks/twilio-fallback` },
                { label: 'Cal.com Webhook', url: `${baseUrl}/webhooks/calcom` },

              ].map(wh => (
                <div key={wh.label} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 12px', background: '#111111', borderRadius: 10,
                }}>
                  <div>
                    <span style={{ fontSize: 11, color: '#444', marginRight: 8 }}>{wh.label}</span>
                    <code style={{ fontSize: 12, color: '#F5F5F0', fontFamily: 'monospace' }}>{wh.url}</code>
                  </div>
                  <button
                    className="btn-ghost"
                    onClick={() => copyToClipboard(wh.url, wh.label)}
                    style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    {copied === wh.label ? <><Check size={11} color="#4ade80" /> Copied</> : <><Copy size={11} /> Copy</>}
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 4 }}>Outbound (configure per client in Settings)</div>
          <div style={{ fontSize: 12, color: '#444' }}>
            {integrations?.webhooks ? (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
                {Object.entries(integrations.webhooks).map(([key, configured]) => (
                  <span key={key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: configured ? '#4ade80' : '#f87171' }} />
                    {key.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            ) : 'Loading...'}
          </div>
        </div>
      </section>

      {/* ========== TEST WEBHOOK ========== */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Test Webhook</h2>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label style={{ fontSize: 11, color: '#444', display: 'block', marginBottom: 4 }}>Event Type</label>
              <select
                value={testEvent}
                onChange={e => setTestEvent(e.target.value)}
                style={{
                  padding: '8px 12px', background: '#1a1a1a', border: '1px solid #222',
                  borderRadius: 10, color: '#F5F5F0', fontSize: 13, minWidth: 200,
                }}
              >
                {EVENT_TYPES.map(et => (
                  <option key={et.value} value={et.value}>{et.label}</option>
                ))}
              </select>
            </div>
            <button
              className="btn-primary"
              onClick={handleTest}
              disabled={testing || !clientId}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px' }}
            >
              <Send size={14} />
              {testing ? 'Sending...' : 'Send Test'}
            </button>
          </div>
          {testResult && (
            <div style={{
              marginTop: 12, padding: '10px 14px', borderRadius: 10,
              background: testResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
              border: `1px solid ${testResult.ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
              color: testResult.ok ? '#4ade80' : '#f87171',
              fontSize: 12,
            }}>
              {testResult.message}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 11, color: '#444' }}>
            Sends a test event with <code style={{ color: '#666' }}>_test: true</code> to your configured webhook URL. Check the delivery log below for results.
          </div>
        </div>
      </section>

      {/* ========== WEBHOOK DELIVERY LOG ========== */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Delivery Log</h2>
        {logLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: '#444' }}>
            <div className="spinner" /> Loading log...
          </div>
        ) : webhookLog.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: '#444' }}>
            No webhook deliveries yet. Configure webhook URLs in Settings, then send a test above.
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #1a1a1a' }}>
                  {['Event', 'URL', 'Attempts', 'Status', 'Time'].map(col => (
                    <th key={col} style={{
                      textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#666',
                      textTransform: 'uppercase', letterSpacing: '0.5px', padding: '12px 16px',
                    }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {webhookLog.map(entry => (
                  <tr key={entry.id} style={{ borderBottom: '1px solid #0d0d0d' }}>
                    <td style={{ padding: '12px 16px', fontSize: 12, color: '#D4AF37', fontWeight: 600 }}>
                      {entry.event}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 12, color: '#666', fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.url}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 12, color: '#666' }}>
                      {entry.attempts}/5
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      {entry.status === 'failed' ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#f87171', fontSize: 12 }}>
                          <AlertTriangle size={12} /> Failed
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#fbbf24', fontSize: 12 }}>
                          <Clock size={12} /> Pending
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 12, color: '#444' }}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ========== GOOGLE SHEETS SETUP GUIDE ========== */}
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileSpreadsheet size={18} color="#4ade80" /> Google Sheets Integration
        </h2>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 13, color: '#F5F5F0', marginBottom: 16 }}>
            Sync leads, calls, and messages to Google Sheets in real-time using Zapier or Make.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#D4AF37', marginBottom: 6 }}>Option 1: Zapier (recommended)</div>
              <ol style={{ fontSize: 12, color: '#666', paddingLeft: 20, lineHeight: 1.8 }}>
                <li>Create a new Zap with trigger <strong>"Webhooks by Zapier" &rarr; "Catch Hook"</strong></li>
                <li>Copy the Zapier webhook URL</li>
                <li>Paste it into the appropriate webhook field in Settings (e.g., Lead Created)</li>
                <li>Send a test event above to verify</li>
                <li>Add action <strong>"Google Sheets" &rarr; "Create Spreadsheet Row"</strong></li>
                <li>Map fields: event, clientId, timestamp, and data fields to columns</li>
              </ol>
            </div>

            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#D4AF37', marginBottom: 6 }}>Option 2: Make (Integromat)</div>
              <ol style={{ fontSize: 12, color: '#666', paddingLeft: 20, lineHeight: 1.8 }}>
                <li>Create a new scenario with <strong>"Webhooks" &rarr; "Custom Webhook"</strong></li>
                <li>Copy the webhook URL and paste into Settings</li>
                <li>Add <strong>"Google Sheets" &rarr; "Add a Row"</strong> module</li>
                <li>Map the incoming JSON fields to your spreadsheet columns</li>
              </ol>
            </div>

            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#D4AF37', marginBottom: 6 }}>Option 3: CSV Export (manual)</div>
              <div style={{ fontSize: 12, color: '#666' }}>
                Use the Data Export section in <strong>Settings</strong> to download CSV files and import into Sheets manually.
              </div>
            </div>
          </div>

          <div style={{
            marginTop: 16, padding: '12px 16px', background: '#1a1a1a', borderRadius: 10,
            fontSize: 12, color: '#444',
          }}>
            <strong style={{ color: '#666' }}>Webhook payload format:</strong>
            <pre style={{ marginTop: 6, color: '#666', fontFamily: 'monospace', fontSize: 11, overflow: 'auto' }}>
{`{
  "event": "call_ended",
  "clientId": "uuid",
  "timestamp": "2026-04-10T...",
  "data": { /* event-specific fields */ }
}`}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}
