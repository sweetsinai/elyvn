const { verifyEmail, lookupMX } = require('../utils/emailVerifier');
const dns = require('dns');
const net = require('net');

jest.mock('dns');
jest.mock('net');

describe('lookupMX', () => {
  it('should lookup MX records for a domain', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [
        { exchange: 'mail.example.com', priority: 10 },
        { exchange: 'mail2.example.com', priority: 20 },
      ]);
    });

    const result = await lookupMX('example.com');
    expect(result).toBe('mail.example.com');
  });

  it('should return null if no MX records found', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(new Error('ENOTFOUND'));
    });

    const result = await lookupMX('invalid-domain.test');
    expect(result).toBe(null);
  });

  it('should pick lowest priority (highest preference)', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [
        { exchange: 'mail3.example.com', priority: 30 },
        { exchange: 'mail1.example.com', priority: 10 },
        { exchange: 'mail2.example.com', priority: 20 },
      ]);
    });

    const result = await lookupMX('priority-test.com');
    expect(result).toBe('mail1.example.com');
  });

  it('should cache MX results', async () => {
    dns.resolveMx.mockClear();
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [{ exchange: 'mail.cached.com', priority: 10 }]);
    });

    await lookupMX('cache-test.com');
    await lookupMX('cache-test.com');

    expect(dns.resolveMx).toHaveBeenCalledTimes(1);
  });
});

describe('verifyEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject empty string', async () => {
    const result = await verifyEmail('');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('empty');
    expect(result.method).toBe('syntax');
  });

  it('should reject null', async () => {
    const result = await verifyEmail(null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('empty');
  });

  it('should reject undefined', async () => {
    const result = await verifyEmail(undefined);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('empty');
  });

  it('should reject invalid syntax (no @)', async () => {
    const result = await verifyEmail('notanemail.com');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_syntax');
    expect(result.method).toBe('syntax');
  });

  it('should reject invalid syntax (no domain)', async () => {
    const result = await verifyEmail('test@');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_syntax');
  });

  it('should reject invalid syntax (no TLD)', async () => {
    const result = await verifyEmail('test@domain');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_syntax');
  });

  it('should accept valid syntax', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [{ exchange: 'mail.validsyntax.test', priority: 10 }]);
    });

    const mockSocket = {
      setTimeout: jest.fn(),
      on: jest.fn(),
      write: jest.fn(),
      destroy: jest.fn(),
      connect: jest.fn(function(port, host) {
        setImmediate(() => {
          const onData = this.on.mock.calls.find(c => c[0] === 'data')[1];
          onData(Buffer.from('220 mail.example.com ESMTP\r\n'));
          setTimeout(() => onData(Buffer.from('250-mail.example.com\r\n')), 10);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 20);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 30);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 40);
        });
      }),
    };

    net.Socket.mockReturnValue(mockSocket);

    const result = await verifyEmail('test@validsyntax.test');
    expect(result.valid).toBe(true);
  });

  it('should reject if no MX records', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(new Error('ENOTFOUND'));
    });

    const result = await verifyEmail('test@nomx.invalid');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_mx_records');
    expect(result.method).toBe('dns');
  });

  it('should skip SMTP for catch-all domains (gmail)', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [{ exchange: 'mail.google.com', priority: 10 }]);
    });

    const result = await verifyEmail('test@gmail.com');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('catch_all_domain');
    expect(result.method).toBe('dns');
  });

  it('should skip SMTP for catch-all domains (yahoo)', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [{ exchange: 'mail.yahoo.com', priority: 10 }]);
    });

    const result = await verifyEmail('test@yahoo.com');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('catch_all_domain');
  });

  it('should accept SMTP 250 response', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [{ exchange: 'mail.example.com', priority: 10 }]);
    });

    const mockSocket = {
      setTimeout: jest.fn(),
      on: jest.fn(),
      write: jest.fn(),
      destroy: jest.fn(),
      connect: jest.fn(function(port, host) {
        setImmediate(() => {
          const onData = this.on.mock.calls.find(c => c[0] === 'data')[1];
          const onTimeout = this.on.mock.calls.find(c => c[0] === 'timeout')?.[1];
          const onError = this.on.mock.calls.find(c => c[0] === 'error')?.[1];

          // Simulate SMTP sequence
          onData(Buffer.from('220 mail.example.com ESMTP\r\n'));
          setTimeout(() => onData(Buffer.from('250-mail.example.com\r\n')), 10);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 20);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 30);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 40);
        });
      }),
    };

    net.Socket.mockReturnValue(mockSocket);

    const result = await verifyEmail('test@example.com');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('accepted');
    expect(result.method).toBe('smtp');
  });

  it('should reject SMTP 550 response', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [{ exchange: 'mail.reject550.test', priority: 10 }]);
    });

    const mockSocket = {
      setTimeout: jest.fn(),
      on: jest.fn(),
      write: jest.fn(),
      destroy: jest.fn(),
      connect: jest.fn(function(port, host) {
        setImmediate(() => {
          const onData = this.on.mock.calls.find(c => c[0] === 'data')?.[1];
          if (!onData) return;
          onData(Buffer.from('220 mail.example.com ESMTP\r\n'));
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 10); // EHLO response
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 20); // MAIL FROM response
          setTimeout(() => onData(Buffer.from('550 User unknown\r\n')), 30); // RCPT TO response
        });
      }),
    };

    net.Socket.mockImplementation(() => mockSocket);

    const result = await verifyEmail('test@reject550.test');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('rejected_550');
  });

  it('should treat temp failures as valid (safe side)', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [{ exchange: 'mail.tempfail.test', priority: 10 }]);
    });

    const mockSocket = {
      setTimeout: jest.fn(),
      on: jest.fn(),
      write: jest.fn(),
      destroy: jest.fn(),
      connect: jest.fn(function(port, host) {
        setImmediate(() => {
          const onData = this.on.mock.calls.find(c => c[0] === 'data')[1];
          onData(Buffer.from('220 mail.example.com ESMTP\r\n'));
          setTimeout(() => onData(Buffer.from('250-mail.example.com\r\n')), 10);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 20);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 30);
          setTimeout(() => onData(Buffer.from('450 Temporary failure\r\n')), 40);
        });
      }),
    };

    net.Socket.mockReturnValue(mockSocket);

    const result = await verifyEmail('test@tempfail.test');
    expect(result.valid).toBe(true);
    expect(result.method).toBe('smtp');
  });

  it('should handle SMTP connection timeout', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [{ exchange: 'mail.timeout.test', priority: 10 }]);
    });

    const mockSocket = {
      setTimeout: jest.fn(),
      on: jest.fn(),
      write: jest.fn(),
      destroy: jest.fn(),
      connect: jest.fn(function(port, host) {
        setImmediate(() => {
          const onTimeout = this.on.mock.calls.find(c => c[0] === 'timeout')?.[1];
          onTimeout?.();
        });
      }),
    };

    net.Socket.mockReturnValue(mockSocket);

    const result = await verifyEmail('test@timeout.test');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('should handle SMTP connection error', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [{ exchange: 'mail.error.test', priority: 10 }]);
    });

    const mockSocket = {
      setTimeout: jest.fn(),
      on: jest.fn(),
      write: jest.fn(),
      destroy: jest.fn(),
      connect: jest.fn(function(port, host) {
        setImmediate(() => {
          const onError = this.on.mock.calls.find(c => c[0] === 'error')?.[1];
          onError?.(new Error('Connection refused'));
        });
      }),
    };

    net.Socket.mockReturnValue(mockSocket);

    const result = await verifyEmail('test@error.test');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('connection_error');
  });

  it('should normalize email to lowercase', async () => {
    dns.resolveMx.mockImplementation((domain, callback) => {
      callback(null, [{ exchange: 'mail.example.com', priority: 10 }]);
    });

    const mockSocket = {
      setTimeout: jest.fn(),
      on: jest.fn(),
      write: jest.fn(),
      destroy: jest.fn(),
      connect: jest.fn(function(port, host) {
        setImmediate(() => {
          const onData = this.on.mock.calls.find(c => c[0] === 'data')[1];
          onData(Buffer.from('220 mail.example.com ESMTP\r\n'));
          setTimeout(() => onData(Buffer.from('250-mail.example.com\r\n')), 10);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 20);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 30);
          setTimeout(() => onData(Buffer.from('250 OK\r\n')), 40);
        });
      }),
    };

    net.Socket.mockReturnValue(mockSocket);

    const result = await verifyEmail('Test@EXAMPLE.COM');
    expect(result.valid).toBe(true);
  });
});
