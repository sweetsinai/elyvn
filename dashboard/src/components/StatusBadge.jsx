const colorMaps = {
  outcome: {
    booked: { bg: 'rgba(74,222,128,0.12)', color: '#4ade80' },
    transferred: { bg: 'rgba(212,175,55,0.12)', color: '#D4AF37' },
    info_provided: { bg: 'rgba(96,165,250,0.12)', color: '#60a5fa' },
    missed: { bg: 'rgba(248,113,113,0.12)', color: '#f87171' },
  },
  source: {
    claude: { bg: 'rgba(96,165,250,0.12)', color: '#60a5fa' },
    template: { bg: 'rgba(212,175,55,0.12)', color: '#D4AF37' },
  },
  stage: {
    new: { bg: 'rgba(96,165,250,0.12)', color: '#60a5fa' },
    contacted: { bg: 'rgba(212,175,55,0.12)', color: '#D4AF37' },
    qualified: { bg: 'rgba(212,175,55,0.12)', color: '#D4AF37' },
    booked: { bg: 'rgba(74,222,128,0.12)', color: '#4ade80' },
    completed: { bg: 'rgba(74,222,128,0.12)', color: '#4ade80' },
    lost: { bg: 'rgba(248,113,113,0.12)', color: '#f87171' },
  },
  classification: {
    interested: { bg: 'rgba(74,222,128,0.12)', color: '#4ade80' },
    question: { bg: 'rgba(212,175,55,0.12)', color: '#D4AF37' },
    not_interested: { bg: 'rgba(248,113,113,0.12)', color: '#f87171' },
    unsubscribe: { bg: 'rgba(248,113,113,0.12)', color: '#f87171' },
  },
  status: {
    auto_replied: { bg: 'rgba(74,222,128,0.12)', color: '#4ade80' },
    escalated: { bg: 'rgba(212,175,55,0.12)', color: '#D4AF37' },
    failed: { bg: 'rgba(248,113,113,0.12)', color: '#f87171' },
    sent: { bg: 'rgba(74,222,128,0.12)', color: '#4ade80' },
    pending: { bg: 'rgba(212,175,55,0.12)', color: '#D4AF37' },
    connected: { bg: 'rgba(74,222,128,0.12)', color: '#4ade80' },
    error: { bg: 'rgba(248,113,113,0.12)', color: '#f87171' },
    missing: { bg: 'rgba(248,113,113,0.12)', color: '#f87171' },
    configured: { bg: 'rgba(74,222,128,0.12)', color: '#4ade80' },
  },
};

const fallback = { bg: 'rgba(212,175,55,0.06)', color: '#666' };

export default function StatusBadge({ status, type = 'outcome' }) {
  if (!status) return null;
  const map = colorMaps[type] || colorMaps.outcome;
  const s = map[status] || fallback;
  const label = status.replace(/_/g, ' ');

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '3px 8px',
      borderRadius: 6,
      fontSize: 11,
      fontWeight: 500,
      textTransform: 'capitalize',
      background: s.bg,
      color: s.color,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}
