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

  const steps = [
    { name: 'Creating client', duration: 2000 },
    { name: 'Provisioning Telnyx', duration: 3000 },
    { name: 'Setting up AI agent', duration: 3500 },
    { name: 'Creating knowledge base', duration: 2500 },
    { name: 'Setting up Telegram bot', duration: 2000 }
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

  const simulateLoading = async () => {
    for (let i = 0; i < steps.length; i++) {
      setCurrentStep(i);
      await new Promise(resolve => setTimeout(resolve, steps[i].duration));
    }
  };

  const handleProvision = async (e) => {
    e.preventDefault();

    if (!validateForm()) return;

    setStatus('loading');
    setCurrentStep(0);

    try {
      await simulateLoading();

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
            color: '#888',
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
                background: '#0d0d0d',
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
                  <Building2 size={18} style={{ color: '#C9A84C' }} />
                  Business Information
                </h2>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                  <div>
                    <label style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: '#888',
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
                      color: '#888',
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
                      color: '#888',
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
                background: '#0d0d0d',
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
                  <User size={18} style={{ color: '#C9A84C' }} />
                  Owner Information
                </h2>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                  <div>
                    <label style={{
                      fontSize: '12px',
                      fontWeight: '600',
                      color: '#888',
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
                      color: '#888',
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
                      color: '#888',
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
                background: '#0d0d0d',
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
                  <Package size={18} style={{ color: '#C9A84C' }} />
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
                        border: formData.plan === plan.id ? '2px solid #C9A84C' : '1px solid rgba(255,255,255,0.1)',
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
                          background: '#C9A84C',
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
                        color: '#C9A84C',
                        margin: '8px 0'
                      }}>
                        {plan.price}
                        <span style={{
                          fontSize: '12px',
                          color: '#888',
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
                            color: '#888',
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
                background: '#0d0d0d',
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
                      color: '#888',
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
                      color: '#888',
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
                  background: '#C9A84C',
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
                  e.currentTarget.style.background = '#C9A84C';
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
            background: '#0d0d0d',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '12px',
            padding: '40px',
            textAlign: 'center'
          }}>
            <Loader size={48} style={{
              color: '#C9A84C',
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
              color: '#888',
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
                    background: idx < currentStep ? '#C9A84C' : idx === currentStep ? 'rgba(201, 168, 76, 0.2)' : 'rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    fontWeight: '600',
                    color: idx < currentStep ? '#0a0a0a' : '#888'
                  }}>
                    {idx < currentStep ? (
                      <Check size={14} />
                    ) : (
                      idx + 1
                    )}
                  </div>
                  <span style={{
                    fontSize: '13px',
                    color: idx <= currentStep ? '#fff' : '#888',
                    fontWeight: idx === currentStep ? '600' : '400'
                  }}>
                    {step.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Success State */}
        {status === 'success' && provisionData && (
          <div className="fade-in" style={{
            background: '#0d0d0d',
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
                border: '2px solid #C9A84C',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 20px'
              }}>
                <Check size={32} style={{ color: '#C9A84C' }} />
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
                color: '#888'
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
                {Object.entries(provisionData.provisioned).map(([service, status]) => (
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
                        color: '#C9A84C',
                        flexShrink: 0
                      }}>
                        <Check size={18} />
                      </div>
                    ) : (
                      <div style={{
                        color: '#888',
                        flexShrink: 0
                      }}>
                        <AlertCircle size={18} />
                      </div>
                    )}
                    <span style={{
                      fontSize: '13px',
                      color: '#fff',
                      textTransform: 'capitalize'
                    }}>
                      {service.replace(/_/g, ' ')}
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
                  color: '#888',
                  display: 'block',
                  marginBottom: '8px'
                }}>
                  Telnyx Phone Number
                </label>
                <p style={{
                  fontSize: '16px',
                  fontWeight: '600',
                  color: '#C9A84C',
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
                  color: '#888',
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
                    color: '#888',
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
                      color: '#C9A84C',
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
                  background: '#C9A84C',
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
                  e.currentTarget.style.background = '#C9A84C';
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
                  color: '#888',
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
                  e.currentTarget.style.color = '#888';
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
            background: '#0d0d0d',
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
                color: '#888',
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
                  background: '#C9A84C',
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
                  e.currentTarget.style.background = '#C9A84C';
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
                  color: '#888',
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
                  e.currentTarget.style.color = '#888';
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
