/**
 * OpenTelemetry Distributed Tracing
 * Initializes OTel SDK with auto-instrumentation for http, express, fetch.
 * Active by default in production (NODE_ENV=production). All imports are
 * wrapped in try/catch so the server never crashes if OTel packages aren't
 * installed. Set OTEL_DISABLED=true to explicitly disable.
 */

const { logger } = require('./logger');

let tracer = null;
let sdk = null;
let traceApi = null;
let propagationApi = null;
let W3CTraceContextPropagator = null;

function initTracing() {
  const isProduction = process.env.NODE_ENV === 'production';
  const disabled = process.env.OTEL_DISABLED === 'true';

  if (disabled || !isProduction) {
    if (disabled) {
      logger.info('[tracing] OTel disabled (OTEL_DISABLED=true)');
    } else {
      logger.info('[tracing] OTel disabled (not production; set NODE_ENV=production to enable)');
    }
    return;
  }

  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const opentelemetryApi = require('@opentelemetry/api');
    const { W3CTraceContextPropagator: W3CPropagator } = require('@opentelemetry/core');

    traceApi = opentelemetryApi.trace;
    propagationApi = opentelemetryApi.propagation;
    W3CTraceContextPropagator = W3CPropagator;

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

    sdk = new NodeSDK({
      serviceName: 'elyvn-bridge',
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-http': { enabled: true },
          '@opentelemetry/instrumentation-express': { enabled: true },
          '@opentelemetry/instrumentation-fetch': { enabled: true },
        }),
      ],
    });

    sdk.start();
    tracer = traceApi.getTracer('elyvn-bridge');
    logger.info(`[tracing] OTel initialized — exporting to ${endpoint}`);
  } catch (err) {
    logger.warn('[tracing] OTel packages not installed or init failed:', err.message);
    tracer = null;
    sdk = null;
  }
}

/**
 * Returns the active tracer, or null if OTel is disabled/unavailable.
 */
function getTracer() {
  return tracer;
}

/**
 * Returns the current active span's traceId, or null.
 */
function getActiveTraceId() {
  if (!traceApi) return null;
  try {
    const span = traceApi.getActiveSpan();
    if (span) {
      const ctx = span.spanContext();
      if (ctx && ctx.traceId) return ctx.traceId;
    }
  } catch (err) {
    logger.debug('Silent catch remediation:', err.message);
  }
  return null;
}

/**
 * Injects W3C traceparent/tracestate headers into an outbound headers object.
 * Returns the headers object (mutated) with trace context injected.
 * Safe no-op if OTel is not active.
 */
function addTraceHeaders(headers = {}) {
  if (!propagationApi || !W3CTraceContextPropagator) return headers;
  try {
    const { context } = require('@opentelemetry/api');
    const carrier = { ...headers };
    propagationApi.inject(context.active(), carrier);
    return carrier;
  } catch (_) {
    return headers;
  }
}

/**
 * Gracefully shut down the OTel SDK (call during server shutdown).
 */
async function shutdownTracing() {
  if (sdk) {
    try {
      await sdk.shutdown();
      logger.info('[tracing] OTel SDK shut down');
    } catch (err) {
      logger.warn('[tracing] OTel shutdown error:', err.message);
    }
  }
}

// Initialize on require
initTracing();

module.exports = { getTracer, getActiveTraceId, addTraceHeaders, shutdownTracing };
