export function formatPhone(phone) {
  if (!phone) return 'Unknown';
  const digits = phone.replace(/\D/g, '');
  const national = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (national.length === 10) {
    return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }
  return phone;
}

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '--';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const remaining = s % 60;
  if (m === 0) return `${remaining}s`;
  return `${m}m ${remaining}s`;
}

export function formatCurrency(amount) {
  if (amount == null) return '$0';
  return '$' + Number(amount).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr);
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

export function truncate(str, len = 60) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len) + '...';
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatTime(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function buildQueryString(params) {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '' && v !== 'all');
  if (!entries.length) return '';
  return '?' + new URLSearchParams(entries).toString();
}
