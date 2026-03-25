/**
 * Graceful Shutdown Handler
 * Ensures clean database close, pending job completion, and connection draining on SIGTERM/SIGINT.
 */

let isShuttingDown = false;
const shutdownCallbacks = [];

function onShutdown(callback) {
  shutdownCallbacks.push(callback);
}

function initGracefulShutdown(server, db) {
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[shutdown] ${signal} received — starting graceful shutdown...`);

    // 1. Stop accepting new connections
    if (server) {
      server.close(() => {
        console.log('[shutdown] HTTP server closed — no new connections');
      });
    }

    // 2. Run registered shutdown callbacks
    for (const cb of shutdownCallbacks) {
      try {
        await cb();
      } catch (err) {
        console.error('[shutdown] Callback error:', err.message);
      }
    }

    // 3. Close database
    if (db) {
      try {
        const { closeDatabase } = require('./dbAdapter');
        closeDatabase(db);
      } catch (err) {
        console.error('[shutdown] DB close error:', err.message);
      }
    }

    console.log('[shutdown] Graceful shutdown complete');
    process.exit(0);
  };

  // Give 10 seconds for graceful shutdown, then force exit
  const forceShutdown = (signal) => {
    shutdown(signal);
    setTimeout(() => {
      console.error('[shutdown] Forced exit after 10s timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => forceShutdown('SIGTERM'));
  process.on('SIGINT', () => forceShutdown('SIGINT'));

  return { onShutdown, isShuttingDown: () => isShuttingDown };
}

module.exports = { initGracefulShutdown, onShutdown };
