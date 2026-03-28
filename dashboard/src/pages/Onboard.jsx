import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';

const INDUSTRIES = [
  'Dental', 'Med Spa', 'Salon / Barbershop', 'HVAC', 'Plumbing', 'Electrical',
  'Real Estate', 'Legal', 'Auto Repair', 'Gym / Fitness', 'Veterinary', 'Other'
];

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function Onboard() {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const clientId = sessionStorage.getItem('elyvn_client_id') || localStorage.getItem('elyvn_client_id');

  // Step 1 — Business Info
  const [industry, setIndustry] = useState('');
  const [address, setAddress] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');

  // Step 2 — Services
  const [services, setServices] = useState([{ name: '', duration: '30', price: '' }]);

  // Step 3 — Business Hours
  const [hours, setHours] = useState(
    Object.fromEntries(DAYS.map(d => [d, d === 'Sunday' ? { open: false, start: '09:00', end: '17:00' } : { open: true, start: '09:00', end: '17:00' }]))
  );

  // Step 4 — Summary
  const [phoneNumber, setPhoneNumber] = useState('');

  function addService() {
    setServices([...services, { name: '', duration: '30', price: '' }]);
  }
  function updateService(idx, field, val) {
    const copy = [...services];
    copy[idx][field] = val;
    setServices(copy);
  }
  function removeService(idx) {
    setServices(services.filter((_, i) => i !== idx));
  }

  async function saveStep(nextStep) {
    setSaving(true);
    setError('');
    try {
      const validServices = services.filter(s => s.name.trim());
      const hoursStr = JSON.stringify(hours);
      const servicesStr = validServices.map(s => `${s.name} (${s.duration} min${s.price ? ', $' + s.price : ''})`).join('\n');

      // Generate knowledge base from inputs
      const kb = [
        `Services offered:\n${servicesStr}`,
        `Business hours:\n${DAYS.filter(d => hours[d].open).map(d => `${d}: ${hours[d].start} - ${hours[d].end}`).join('\n')}`,
        address ? `Location: ${address}` : '',
      ].filter(Boolean).join('\n\n');

      await apiFetch(`/api/clients/${clientId}`, {
        method: 'PUT',
        body: JSON.stringify({
          industry,
          timezone,
          business_hours: hoursStr,
          knowledge_base: kb,
          onboarding_step: nextStep,
          onboarding_completed: nextStep > 4 ? 1 : 0,
        }),
      });

      if (nextStep > 4) {
        setComplete(true);
      } else {
        setStep(nextStep);
      }
    } catch (err) {
      setError(err.message || 'Failed to save');
    }
    setSaving(false);
  }

  const cardStyle = {
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 16, padding: 32, maxWidth: 640, margin: '0 auto',
  };
  const inputStyle = {
    width: '100%', padding: '10px 14px', fontSize: 14, borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--bg-input, #fff)',
    color: 'var(--text-primary)', boxSizing: 'border-box', outline: 'none',
  };
  const btnPrimary = {
    padding: '12px 32px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)',
    color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 600,
    cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
  };
  const btnSecondary = {
    padding: '12px 24px', background: 'transparent', color: 'var(--text-secondary)',
    border: '1px solid var(--border)', borderRadius: 10, fontSize: 14, cursor: 'pointer',
  };

  if (complete) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
        <h2 style={{ fontSize: 24, marginBottom: 8, color: 'var(--text-primary)' }}>You're All Set!</h2>
        <p style={{ color: 'var(--text-secondary)', maxWidth: 400, margin: '0 auto 24px' }}>
          Your AI receptionist is being configured. You'll receive a confirmation on Telegram once it's live.
        </p>
        <button onClick={() => window.location.href = '/'} style={btnPrimary}>
          Go to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '40px 20px' }}>
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
          Set Up Your AI Receptionist
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Step {step} of 4</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
          {[1, 2, 3, 4].map(s => (
            <div key={s} style={{
              width: 48, height: 4, borderRadius: 2,
              background: s <= step ? '#7C3AED' : 'var(--border)',
              transition: 'background 0.3s',
            }} />
          ))}
        </div>
      </div>

      {error && (
        <div style={{ maxWidth: 640, margin: '0 auto 16px', padding: '12px 16px', background: '#FEE2E2', borderRadius: 8, color: '#DC2626', fontSize: 14 }}>
          {error}
        </div>
      )}

      {step === 1 && (
        <div style={cardStyle}>
          <h3 style={{ fontSize: 18, marginBottom: 20, color: 'var(--text-primary)' }}>Business Information</h3>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>Industry</label>
            <select value={industry} onChange={e => setIndustry(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="">Select your industry...</option>
              {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>Business Address</label>
            <input value={address} onChange={e => setAddress(e.target.value)} placeholder="123 Main St, City, State" style={inputStyle} />
          </div>
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>Timezone</label>
            <select value={timezone} onChange={e => setTimezone(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="America/New_York">Eastern (ET)</option>
              <option value="America/Chicago">Central (CT)</option>
              <option value="America/Denver">Mountain (MT)</option>
              <option value="America/Los_Angeles">Pacific (PT)</option>
            </select>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={() => saveStep(2)} disabled={saving || !industry} style={btnPrimary}>
              {saving ? 'Saving...' : 'Continue'}
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={cardStyle}>
          <h3 style={{ fontSize: 18, marginBottom: 20, color: 'var(--text-primary)' }}>Your Services</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
            What services do you offer? The AI will use this to answer customer questions.
          </p>
          {services.map((svc, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input value={svc.name} onChange={e => updateService(i, 'name', e.target.value)}
                placeholder="Service name" style={{ ...inputStyle, flex: 2 }} />
              <input value={svc.duration} onChange={e => updateService(i, 'duration', e.target.value)}
                placeholder="Min" style={{ ...inputStyle, flex: 0.5, textAlign: 'center' }} type="number" />
              <input value={svc.price} onChange={e => updateService(i, 'price', e.target.value)}
                placeholder="$" style={{ ...inputStyle, flex: 0.5, textAlign: 'center' }} type="number" />
              {services.length > 1 && (
                <button onClick={() => removeService(i)} style={{ border: 'none', background: 'none', color: '#EF4444', cursor: 'pointer', fontSize: 18, padding: '0 4px' }}>×</button>
              )}
            </div>
          ))}
          <button onClick={addService} style={{ ...btnSecondary, marginTop: 8, fontSize: 13 }}>+ Add Service</button>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
            <button onClick={() => setStep(1)} style={btnSecondary}>Back</button>
            <button onClick={() => saveStep(3)} disabled={saving || !services.some(s => s.name.trim())} style={btnPrimary}>
              {saving ? 'Saving...' : 'Continue'}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div style={cardStyle}>
          <h3 style={{ fontSize: 18, marginBottom: 20, color: 'var(--text-primary)' }}>Business Hours</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
            When are you open? The AI handles after-hours calls differently.
          </p>
          {DAYS.map(day => (
            <div key={day} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <label style={{ width: 90, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                <input type="checkbox" checked={hours[day].open}
                  onChange={e => setHours({ ...hours, [day]: { ...hours[day], open: e.target.checked } })}
                  style={{ marginRight: 8 }} />
                {day.slice(0, 3)}
              </label>
              {hours[day].open ? (
                <>
                  <input type="time" value={hours[day].start}
                    onChange={e => setHours({ ...hours, [day]: { ...hours[day], start: e.target.value } })}
                    style={{ ...inputStyle, width: 120, flex: 'none' }} />
                  <span style={{ color: 'var(--text-secondary)' }}>to</span>
                  <input type="time" value={hours[day].end}
                    onChange={e => setHours({ ...hours, [day]: { ...hours[day], end: e.target.value } })}
                    style={{ ...inputStyle, width: 120, flex: 'none' }} />
                </>
              ) : (
                <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Closed</span>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
            <button onClick={() => setStep(2)} style={btnSecondary}>Back</button>
            <button onClick={() => saveStep(4)} disabled={saving} style={btnPrimary}>
              {saving ? 'Saving...' : 'Continue'}
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div style={cardStyle}>
          <h3 style={{ fontSize: 18, marginBottom: 20, color: 'var(--text-primary)' }}>Ready to Go Live!</h3>
          <div style={{ background: 'rgba(124,58,237,0.08)', borderRadius: 12, padding: 20, marginBottom: 20, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 12 }}>
              Your AI receptionist is configured. Here's what happens next:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left', maxWidth: 340, margin: '0 auto' }}>
              <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>✓ AI trained on your business info</div>
              <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>✓ Phone number will be assigned</div>
              <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>✓ Telegram alerts configured</div>
              <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>✓ 7-day free trial active</div>
            </div>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center', marginBottom: 20 }}>
            Our team will set up your phone number and send you a test call within 24 hours.
          </p>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button onClick={() => setStep(3)} style={btnSecondary}>Back</button>
            <button onClick={() => saveStep(5)} disabled={saving} style={btnPrimary}>
              {saving ? 'Finishing...' : 'Complete Setup'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
