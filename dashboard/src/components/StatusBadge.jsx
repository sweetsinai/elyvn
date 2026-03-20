const colorMaps = {
  outcome: {
    booked: { bg: 'rgba(22,163,74,0.15)', color: '#16A34A' },
    transferred: { bg: 'rgba(234,179,8,0.15)', color: '#EAB308' },
    info_provided: { bg: 'rgba(59,130,246,0.15)', color: '#3B82F6' },
    missed: { bg: 'rgba(220,38,38,0.15)', color: '#DC2626' },
  },
  source: {
    claude: { bg: 'rgba(59,130,246,0.15)', color: '#3B82F6' },
    template: { bg: 'rgba(234,179,8,0.15)', color: '#EAB308' },
  },
  stage: {
    new: { bg: 'rgba(59,130,246,0.15)', color: '#3B82F6' },
    contacted: { bg: 'rgba(234,179,8,0.15)', color: '#EAB308' },
    qualified: { bg: 'rgba(201,168,76,0.15)', color: '#C9A84C' },
    booked: { bg: 'rgba(22,163,74,0.15)', color: '#16A34A' },
    completed: { bg: 'rgba(22,163,74,0.15)', color: '#16A34A' },
    lost: { bg: 'rgba(220,38,38,0.15)', color: '#DC2626' },
  },
  classification: {
    interested: { bg: 'rgba(22,163,74,0.15)', color: '#16A34A' },
    question: { bg: 'rgba(234,179,8,0.15)', color: '#EAB308' },
    not_interested: { bg: 'rgba(220,38,38,0.15)', color: '#DC2626' },
    unsubscribe: { bg: 'rgba(220,38,38,0.15)', color: '#DC2626' },
  },
  status: {
    auto_replied: { bg: 'rgba(22,163,74,0.15)', color: '#16A34A' },
    escalated: { bg: 'rgba(234,179,8,0.15)', color: '#EAB308' },
    failed: { bg: 'rgba(220,38,38,0.15)', color: '#DC2626' },
    sent: { bg: 'rgba(22,163,74,0.15)', color: '#16A34A' },
    pending: { bg: 'rgba(234,179,8,0.15)', color: '#EAB308' },
    connected: { bg: 'rgba(22,163,74,0.15)', color: '#16A34A' },
    error: { bg: 'rgba(220,38,38,0.15)', color: '#DC2626' },
    missing: { bg: 'rgba(220,38,38,0.15)', color: '#DC2626' },
    configured: { bg: 'rgba(22,163,74,0.15)', color: '#16A34A' },
  },
};

const fallback = { bg: 'rgba(255,255,255,0.06)', color: '#888' };

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
      borderRadius: 4,
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
