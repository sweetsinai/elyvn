import React, { useState } from 'react';
import { ChevronRight, Check, Loader, AlertCircle, Phone, Mail, Building2, User, Globe, Package } from 'lucide-react';
import { provisionClient } from '../lib/api';

const INDUSTRIES = [
  'Healthcare',
  'Financial Services',
  'Real Estate',
  'Hospitality',
  'Retail',
  'Professional Services',
  'Education',
  'Tech/Software',
  'Manufacturing',
  'Other'
];

const TIMEZONES = [
  'UTC-8 (PST)',
  'UTC-7 (MST)',
  'UTC-6 (CST)',
  'UTC-5 (EST)',
  'UTC (GMT)',
  'UTC+1 (CET)',
  'UTC+5:30 (IST)',
  'UTC+8 (CST)',
  'UTC+9 (JST)',
  'UTC+10 (AEDT)'
];

const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: '$199',
    period: '/month',
    features: [
      '500 calls/month',
      '1,000 SMS/month',
      '200 emails/month',
      'Telegram bot integration',
      'Email support'
    ]
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$399',
    period: '/month',
    features: [
      '1,500 calls/month',
      '3,000 SMS/month',
      '500 emails/month',
      'Telegram + Web integration',
      'Priority email & chat support',
      'Custom knowledge base'
    ],
    recommended: true
  },
  {
    id: 'premium',
    name: 'Premium',
    price: '$799',
    period: '/month',
    features: [
      'Unlimited calls',
      'Unlimited SMS',
      'Unlimited emails',
      'All integrations (Telegram, Web, Slack)',
      '24/7 phone support',
      'Custom knowledge base + fine-tuning',
      'White-label options'
    ]
  }
];

export default function Provision() {
  // Form state
  const [formData, setFormData] = useState({
    business_name: '',
    owner_name: '',
    owner_phone: '',
    owner_email: '',
    industry: '',
    timezone: '',
    plan: '',
    calcom_booking_link: '',
    transfer_phone: ''
  });

  const [validationErrors, setValidationErrors] = useState({});
  const [status, setStatus] = useState('form'); // 'form', 'loading', 'success', 'error'
  const [provisionData, setProvisionData] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [currentStep, setCurrentStep] = useState(0);
  const [failedSteps, setFailedSteps] = useState([]);

  const steps = [
    { id: 'creating_agent', name: 'Setting up AI agent' },
    { id: 'buying_number', name: 'Provisioning Phone Number' },
    { id: 'creating_client', name: 'Creating client record' },
    { id: 'syncing_kb', name: 'Creating knowledge base' },
    { id: 'setting_up_telegram', name: 'Setting up Telegram bot' }
  ];

  const validateForm = () => {
    const errors = {};

    if (!formData.business_name.trim()) errors.business_name = 'Business name required';
    if (!formData.owner_name.trim()) errors.owner_name = 'Owner name required';
    if (!formData.owner_phone.trim()) errors.owner_phone = 'Phone number required';
    if (!formData.owner_email.trim()) {
      errors.owner_email = 'Email required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.owner_email)) {
      errors.owner_email = 'Invalid email format';
    }
    if (!formData.industry) errors.industry = 'Industry required';
    if (!formData.timezone) errors.timezone = 'Timezone required';
    if (!formData.plan) errors.plan = 'Plan required';

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (validationErrors[name]) {
      setValidationErrors(prev => {
        const updated = { ...prev };
        delete updated[name];
        return updated;
      });
    }
  };

  const handlePlanSelect = (planId) => {
    setFormData(prev => ({ ...prev, plan: planId }));
    if (validationErrors.plan) {
      setValidationErrors(prev => {
        const updated = { ...prev };
        delete updated.plan;
        return updated;
      });
    }
  };

  const handleProvision = async (e) => {
    e.preventDefault();

    if (!validateForm()) return;

    setStatus('loading');
    setCurrentStep(0);
    setFailedSteps([]);

    let socket = null;

    try {
      // Setup WebSocket for real-time progress tracking
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      socket = new WebSocket(wsUrl);

      // Wait for WebSocket authentication before proceeding with provisioning
      // to ensure we don't miss the first progress updates
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error('WebSocket connection timed out'));
        }, 10000);

        socket.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          
          if (msg.type === 'auth_required') {
            const apiKey = sessionStorage.getItem('elyvn_api_key');
            socket.send(JSON.stringify({ type: 'auth', api_key: apiKey }));
          } else if (msg.type === 'authenticated') {
            clearTimeout(timeout);
            resolve();
          } else if (msg.type === 'provisioning_update' && msg.data.businessName === formData.business_name) {
            const { stage, status: stageStatus } = msg.data;
            const stepIndex = steps.findIndex(s => s.id === stage);
            
            if (stepIndex !== -1) {
              setCurrentStep(stepIndex);
              if (stageStatus === 'failed') {
                setFailedSteps(prev => [...new Set([...prev, stage])]);
              } else if (stageStatus === 'completed') {
                // Move to next step visual if completed
                if (stepIndex < steps.length - 1) {
                  setCurrentStep(stepIndex + 1);
                } else {
                  // Last step completed
                  setCurrentStep(steps.length);
                }
              }
            }
          }
        };

        socket.onerror = (err) => {
          clearTimeout(timeout);
          reject(new Error('WebSocket connection failed'));
        };
      });

      const response = await provisionClient(formData);

      if (response.success) {
        setProvisionData(response);
        setStatus('success');
      } else {
        throw new Error(response.error || 'Provisioning failed');
      }
    } catch (error) {
      setErrorMessage(error.message || 'An error occurred during provisioning');
      setStatus('error');
    } finally {
      if (socket) {
        // Small delay to allow any pending WS messages to process
        setTimeout(() => socket.close(), 1000);
      }
    }
  };

  const handleReset = () => {
    setFormData({
      business_name: '',
      owner_name: '',
      owner_phone: '',
      owner_email: '',
      industry: '',
      timezone: '',
      plan: '',
      calcom_booking_link: '',
      transfer_phone: ''
    });
    setValidationErrors({});
    setStatus('form');
    setProvisionData(null);
    setErrorMessage('');
    setCurrentStep(0);
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#fff',
      padding: '40px 20px'
    }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
        {/* Header */}
        <div className="fade-in" style={{ marginBottom: '40px' }}>
          <h1 style={{
            fontSize: '28px',
            fontWeight: '600',
            marginBottom: '8px',
            color: '#fff'
          }}>
            Provision New Client
          </h1>
          <p style={{
            fontSize: '14px',
            color: '#666',
            marginBottom: '0'
          }}>
            One-click setup: Telnyx number + AI agent + Telegram bot
          </p>
        </div>

        {/* Form State */}
        {status === 'form' && (
          <div className="fade-in">
            <form onSubmit={handleProvision}>
              {/* Business Info Section */}
              <div className="card" style={{
                background: '#111111',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '12px',
                padding: '24px',
                marginBottom: '24px'
              }}>
                <h2 style={{
                  fontSize: '16px',
                  fontWeight: '600',
                  marginBottom: '20px',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Building2 size={18} style={{ color: '#D4AF37' }} />
                  Business Information
                </h2>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                  <div>
                    <label style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: '#666',
                      display: 'block',
                      marginBottom: '8px'
                    }}>
                      Business Name
                    </label>
                    <input
                      type="text"
                      name="business_name"
                      value={formData.business_name}
                      onChange={handleInputChange}
                      placeholder="Acme Corp"
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        background: '#0a0a0a',
                        border: validationErrors.business_name ? '1px solid #ff6b6b' : '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '13px',
                        fontFamily: 'inherit',
                        boxSizing: 'border-box'
                      }}
                    />
                    {validationErrors.business_name && (
                      <p style={{ fontSize: '11px', color: '#ff6b6b', marginTop: '4px', margin: '0' }}>
                        {validationErrors.business_name}
                      </p>
                    )}
                  </div>

                  <div>
                    <label style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: '#666',
                      display: 'block',
                      marginBottom: '8px'
                    }}>
                      Industry
                    </label>
                    <select
                      name="industry"
                      value={formData.industry}
                      onChange={handleInputChange}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        background: '#0a0a0a',
                        border: validationErrors.industry ? '1px solid #ff6b6b' : '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '13px',
                        fontFamily: 'inherit',
                        boxSizing: 'border-box',
                        cursor: 'pointer'
                      }}
                    >
                      <option value="">Select an industry</option>
                      {INDUSTRIES.map(ind => (
                        <option key={ind} value={ind} style={{ background: '#0a0a0a', color: '#fff' }}>
                          {ind}
                        </option>
                      ))}
                    </select>
                    {validationErrors.industry && (
                      <p style={{ fontSize: '11px', color: '#ff6b6b', marginTop: '4px', margin: '0' }}>
                        {validationErrors.industry}
                      </p>
                    )}
                  </div>

                  <div>
                    <label style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: '#666',
                      display: 'block',
                      marginBottom: '8px'
                    }}>
                      Timezone
                    </label>
                    <select
                      name="timezone"
                      value={formData.timezone}
                      onChange={handleInputChange}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        background: '#0a0a0a',
                        border: validationErrors.timezone ? '1px solid #ff6b6b' : '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '13px',
                        fontFamily: 'inherit',
                        boxSizing: 'border-box',
                        cursor: 'pointer'
                      }}
                    >
                      <option value="">Select timezone</option>
                      {TIMEZONES.map(tz => (
                        <option key={tz} value={tz} style={{ background: '#0a0a0a', color: '#fff' }}>
                          {tz}
                        </option>
                      ))}
                    </select>
                    {validationErrors.timezone && (
                      <p style={{ fontSize: '11px', color: '#ff6b6b', marginTop: '4px', margin: '0' }}>
                        {validationErrors.timezone}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Owner Info Section */}
              <div className="card" style={{
                background: '#111111',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '12px',
                padding: '24px',
                marginBottom: '24px'
              }}>
                <h2 style={{
                  fontSize: '16px',
                  fontWeight: '600',
                  marginBottom: '20px',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <User size={18} style={{ color: '#D4AF37' }} />
                  Owner Information
                </h2>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                  <div>
                    <label style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: '#666',
                      display: 'block',
                      marginBottom: '8px'
                    }}>
                      Name
                    </label>
                    <input
                      type="text"
                      name="owner_name"
                      value={formData.owner_name}
                      onChange={handleInputChange}
                      placeholder="John Doe"
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        background: '#0a0a0a',
                        border: validationErrors.owner_name ? '1px solid #ff6b6b' : '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '13px',
                        fontFamily: 'inherit',
                        boxSizing: 'border-box'
                      }}
                    />
                    {validationErrors.owner_name && (
                      <p style={{ fontSize: '11px', color: '#ff6b6b', marginTop: '4px', margin: '0' }}>
                        {validationErrors.owner_name}
                      </p>
                    )}
                  </div>

                  <div>
                    <label style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: '#666',
                      display: 'block',
                      marginBottom: '8px'
                    }}>
                      Phone
                    </label>
                    <input
                      type="tel"
                      name="owner_phone"
                      value={formData.owner_phone}
                      onChange={handleInputChange}
                      placeholder="+1 (555) 000-0000"
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        background: '#0a0a0a',
                        border: validationErrors.owner_phone ? '1px solid #ff6b6b' : '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '13px',
                        fontFamily: 'inherit',
                        boxSizing: 'border-box'
                      }}
                    />
                    {validationErrors.owner_phone && (
                      <p style={{ fontSize: '11px', color: '#ff6b6b', marginTop: '4px', margin: '0' }}>
                        {validationErrors.owner_phone}
                      </p>
                    )}
                  </div>

                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: '#666',
                      display: 'block',
                      marginBottom: '8px'
                    }}>
                      Email
                    </label>
                    <input
                      type="email"
                      name="owner_email"
                      value={formData.owner_email}
                      onChange={handleInputChange}
                      placeholder="john@acmecorp.com"
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        background: '#0a0a0a',
                        border: validationErrors.owner_email ? '1px solid #ff6b6b' : '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '13px',
                        fontFamily: 'inherit',
                        boxSizing: 'border-box'
                      }}
                    />
                    {validationErrors.owner_email && (
                      <p style={{ fontSize: '11px', color: '#ff6b6b', marginTop: '4px', margin: '0' }}>
                        {validationErrors.owner_email}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Plan Selection */}
              <div className="card" style={{
                background: '#111111',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '12px',
                padding: '24px',
                marginBottom: '24px'
              }}>
                <h2 style={{
                  fontSize: '16px',
                  fontWeight: '600',
                  marginBottom: '20px',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Package size={18} style={{ color: '#D4AF37' }} />
                  Select Plan
                </h2>

                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: '16px',
                  marginBottom: '16px'
                }}>
                  {PLANS.map(plan => (
                    <div
                      key={plan.id}
                      onClick={() => handlePlanSelect(plan.id)}
                      style={{
                        padding: '20px',
                        background: formData.plan === plan.id ? 'rgba(201, 168, 76, 0.1)' : '#0a0a0a',
                        border: formData.plan === plan.id ? '2px solid #D4AF37' : '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '12px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        position: 'relative',
                        boxSizing: 'border-box'
                      }}
                      onMouseEnter={(e) => {
                        if (formData.plan !== plan.id) {
                          e.currentTarget.style.borderColor = 'rgba(201, 168, 76, 0.3)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (formData.plan !== plan.id) {
                          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                        }
                      }}
                    >
                      {plan.recommended && (
                        <div style={{
                          position: 'absolute',
                          top: '-12px',
                          left: '50%',
                          transform: 'translateX(-50%)',
                          background: '#D4AF37',
                          color: '#0a0a0a',
                          padding: '4px 12px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: '600'
                        }}>
                          Recommended
                        </div>
                      )}
                      <h3 style={{
                        fontSize: '16px',
                        fontWeight: '600',
                        marginBottom: '4px',
                        color: '#fff'
                      }}>
                        {plan.name}
                      </h3>
                      <p style={{
                        fontSize: '20px',
                        fontWeight: '700',
                        color: '#D4AF37',
                        margin: '8px 0'
                      }}>
                        {plan.price}
                        <span style={{
                          fontSize: '12px',
                          color: '#666',
                          fontWeight: '400',
                          marginLeft: '4px'
                        }}>
                          {plan.period}
                        </span>
                      </p>
                      <ul style={{
                        listStyle: 'none',
                        padding: '0',
                        margin: '12px 0 0 0'
                      }}>
                        {plan.features.map((feature, idx) => (
                          <li key={idx} style={{
                            fontSize: '12px',
                            color: '#666',
                            marginBottom: '8px',
                            paddingLeft: '0'
                          }}>
                            • {feature}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>

                {validationErrors.plan && (
                  <p style={{ fontSize: '11px', color: '#ff6b6b', margin: '0' }}>
                    {validationErrors.plan}
                  </p>
                )}
              </div>

              {/* Optional Fields */}
              <div className="card" style={{
                background: '#111111',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '12px',
                padding: '24px',
                marginBottom: '24px'
              }}>
                <h2 style={{
                  fontSize: '16px',
                  fontWeight: '600',
                  marginBottom: '20px',
                  color: '#fff'
                }}>
                  Optional Services
                </h2>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                  <div>
                    <label style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: '#666',
                      display: 'block',
                      marginBottom: '8px'
                    }}>
                      Cal.com Booking Link (optional)
                    </label>
                    <input
                      type="url"
                      name="calcom_booking_link"
                      value={formData.calcom_booking_link}
                      onChange={handleInputChange}
                      placeholder="https://cal.com/username"
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        background: '#0a0a0a',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '13px',
                        fontFamily: 'inherit',
                        boxSizing: 'border-box'
                      }}
                    />
                  </div>

                  <div>
                    <label style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: '#666',
                      display: 'block',
                      marginBottom: '8px'
                    }}>
                      Phone Transfer Number (optional)
                    </label>
                    <input
                      type="tel"
                      name="transfer_phone"
                      value={formData.transfer_phone}
                      onChange={handleInputChange}
                      placeholder="+1 (555) 000-0000"
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        background: '#0a0a0a',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        color: '#fff',
                        fontSize: '13px',
                        fontFamily: 'inherit',
                        boxSizing: 'border-box'
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                style={{
                  width: '100%',
                  padding: '14px 24px',
                  background: '#D4AF37',
                  color: '#0a0a0a',
                  border: 'none',
                  borderRadius: '12px',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#d4b15a';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 8px 24px rgba(201, 168, 76, 0.2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#D4AF37';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                Provision Client
                <ChevronRight size={18} />
              </button>
            </form>
          </div>
        )}

        {/* Loading State */}
        {status === 'loading' && (
          <div className="fade-in" style={{
            background: '#111111',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '12px',
            padding: '40px',
            textAlign: 'center'
          }}>
            <Loader size={48} style={{
              color: '#D4AF37',
              margin: '0 auto 24px',
              animation: 'spin 1s linear infinite'
            }} />
            <style>{`
              @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
              }
            `}</style>

            <h2 style={{
              fontSize: '20px',
              fontWeight: '600',
              marginBottom: '8px',
              color: '#fff'
            }}>
              Provisioning Client...
            </h2>

            <p style={{
              fontSize: '13px',
              color: '#666',
              marginBottom: '32px'
            }}>
              Setting up all services. This typically takes 2-3 minutes.
            </p>

            {/* Progress Steps */}
            <div style={{
              maxWidth: '400px',
              margin: '0 auto'
            }}>
              {steps.map((step, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '12px 0',
                    borderBottom: idx < steps.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none'
                  }}
                >
                  <div style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    background: failedSteps.includes(step.id) ? '#ff6b6b' : idx < currentStep ? '#D4AF37' : idx === currentStep ? 'rgba(201, 168, 76, 0.2)' : 'rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    fontWeight: '600',
                    color: failedSteps.includes(step.id) || idx < currentStep ? '#0a0a0a' : '#666'
                  }}>
                    {failedSteps.includes(step.id) ? (
                      <AlertCircle size={14} />
                    ) : idx < currentStep ? (
                      <Check size={14} />
                    ) : (
                      idx + 1
                    )}
                  </div>
                  <span style={{
                    fontSize: '13px',
                    color: failedSteps.includes(step.id) ? '#ff6b6b' : idx <= currentStep ? '#fff' : '#666',
                    fontWeight: idx === currentStep ? '600' : '400'
                  }}>
                    {step.name}
                    {failedSteps.includes(step.id) && <span style={{ fontSize: '11px', marginLeft: '8px' }}>(Failed)</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Success State */}
        {status === 'success' && provisionData && (
          <div className="fade-in" style={{
            background: '#111111',
            border: '1px solid rgba(201, 168, 76, 0.3)',
            borderRadius: '12px',
            padding: '40px'
          }}>
            <div style={{
              textAlign: 'center',
              marginBottom: '40px'
            }}>
              <div style={{
                width: '60px',
                height: '60px',
                borderRadius: '50%',
                background: 'rgba(201, 168, 76, 0.1)',
                border: '2px solid #D4AF37',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 20px'
              }}>
                <Check size={32} style={{ color: '#D4AF37' }} />
              </div>
              <h2 style={{
                fontSize: '24px',
                fontWeight: '600',
                marginBottom: '8px',
                color: '#fff'
              }}>
                Client Provisioned Successfully!
              </h2>
              <p style={{
                fontSize: '13px',
                color: '#666'
              }}>
                {provisionData.client.business_name} is ready to go.
              </p>
            </div>

            {/* Provisioned Services */}
            <div style={{
              background: '#0a0a0a',
              borderRadius: '12px',
              padding: '24px',
              marginBottom: '32px'
            }}>
              <h3 style={{
                fontSize: '14px',
                fontWeight: '600',
                color: '#fff',
                marginBottom: '16px'
              }}>
                Provisioned Services
              </h3>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                {Object.entries({
                  'AI Agent': provisionData.provisioning_status.retell_agent_id,
                  'Dedicated Number': provisionData.provisioning_status.phone_number,
                  'Database Record': provisionData.provisioning_status.db_save,
                  'Knowledge Base': provisionData.provisioning_status.kb_save,
                  'Telegram Bot': provisionData.provisioning_status.telegram_link
                }).map(([service, status]) => (
                  <div
                    key={service}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '12px',
                      background: 'rgba(201, 168, 76, 0.05)',
                      borderRadius: '8px'
                    }}
                  >
                    {status ? (
                      <div style={{
                        color: '#D4AF37',
                        flexShrink: 0
                      }}>
                        <Check size={18} />
                      </div>
                    ) : (
                      <div style={{
                        color: '#666',
                        flexShrink: 0
                      }}>
                        <AlertCircle size={18} />
                      </div>
                    )}
                    <span style={{
                      fontSize: '13px',
                      color: '#fff'
                    }}>
                      {service}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Client Details */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '16px',
              marginBottom: '32px'
            }}>
              <div style={{
                background: '#0a0a0a',
                borderRadius: '12px',
                padding: '20px'
              }}>
                <label style={{
                  fontSize: '11px',
                  fontWeight: '600',
                  color: '#666',
                  display: 'block',
                  marginBottom: '8px'
                }}>
                  Telnyx Phone Number
                </label>
                <p style={{
                  fontSize: '16px',
                  fontWeight: '600',
                  color: '#D4AF37',
                  margin: '0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Phone size={18} />
                  {provisionData.client.phone_number || provisionData.client.twilio_phone}
                </p>
              </div>

              <div style={{
                background: '#0a0a0a',
                borderRadius: '12px',
                padding: '20px'
              }}>
                <label style={{
                  fontSize: '11px',
                  fontWeight: '600',
                  color: '#666',
                  display: 'block',
                  marginBottom: '8px'
                }}>
                  AI Agent ID
                </label>
                <p style={{
                  fontSize: '14px',
                  fontFamily: 'monospace',
                  color: '#fff',
                  margin: '0',
                  wordBreak: 'break-all'
                }}>
                  {provisionData.client.retell_agent_id}
                </p>
              </div>

              {provisionData.telegram_link && (
                <div style={{
                  gridColumn: '1 / -1',
                  background: '#0a0a0a',
                  borderRadius: '12px',
                  padding: '20px'
                }}>
                  <label style={{
                    fontSize: '11px',
                    fontWeight: '600',
                    color: '#666',
                    display: 'block',
                    marginBottom: '8px'
                  }}>
                    Telegram Bot Onboarding Link
                  </label>
                  <a
                    href={provisionData.telegram_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: '13px',
                      color: '#D4AF37',
                      textDecoration: 'none',
                      wordBreak: 'break-all',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.textDecoration = 'underline';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.textDecoration = 'none';
                    }}
                  >
                    {provisionData.telegram_link}
                    <ChevronRight size={14} />
                  </a>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '12px'
            }}>
              <button
                onClick={() => {
                  window.location.href = `/dashboard/clients/${provisionData.client.id}`;
                }}
                style={{
                  padding: '12px 24px',
                  background: '#D4AF37',
                  color: '#0a0a0a',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#d4b15a';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#D4AF37';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                Go to Client Dashboard
              </button>

              <button
                onClick={handleReset}
                style={{
                  padding: '12px 24px',
                  background: 'transparent',
                  color: '#666',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '8px',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                  e.currentTarget.style.color = '#fff';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = '#666';
                }}
              >
                Provision Another Client
              </button>
            </div>
          </div>
        )}

        {/* Error State */}
        {status === 'error' && (
          <div className="fade-in" style={{
            background: '#111111',
            border: '1px solid rgba(255, 107, 107, 0.3)',
            borderRadius: '12px',
            padding: '40px'
          }}>
            <div style={{
              textAlign: 'center',
              marginBottom: '32px'
            }}>
              <div style={{
                width: '60px',
                height: '60px',
                borderRadius: '50%',
                background: 'rgba(255, 107, 107, 0.1)',
                border: '2px solid #ff6b6b',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 20px'
              }}>
                <AlertCircle size={32} style={{ color: '#ff6b6b' }} />
              </div>
              <h2 style={{
                fontSize: '24px',
                fontWeight: '600',
                marginBottom: '8px',
                color: '#fff'
              }}>
                Provisioning Failed
              </h2>
              <p style={{
                fontSize: '13px',
                color: '#666',
                marginBottom: '16px'
              }}>
                {errorMessage}
              </p>
            </div>

            {/* Action Buttons */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '12px'
            }}>
              <button
                onClick={handleReset}
                style={{
                  padding: '12px 24px',
                  background: '#D4AF37',
                  color: '#0a0a0a',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#d4b15a';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#D4AF37';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                Try Again
              </button>

              <button
                onClick={() => {
                  window.location.href = '/dashboard';
                }}
                style={{
                  padding: '12px 24px',
                  background: 'transparent',
                  color: '#666',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '8px',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                  e.currentTarget.style.color = '#fff';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = '#666';
                }}
              >
                Back to Dashboard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
