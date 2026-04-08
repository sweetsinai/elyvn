require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

// Initialize file-based logging (must be before any console.log calls)
const { setupLogger, closeLogger, logger } = require('./utils/logger');
setupLogger();

// Initialize monitoring & error tracking
const { initMonitoring, captureException } = require('./utils/monitoring');
initMonitoring();

// Startup helpers
const { alertCriticalError, validateEnv, initializeDatabase, initializeServer } = require('./config/startup');

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  captureException(err, { type: 'unhandledRejection' });
  logger.error('[CRASH] UNHANDLED REJECTION:', reason);
  alertCriticalError('Unhandled Rejection', err);
});

process.on('uncaughtException', (error) => {
  captureException(error, { type: 'uncaughtException' });
  logger.error('[CRASH] UNCAUGHT EXCEPTION — process will exit:', error);
  Promise.resolve(alertCriticalError('Uncaught Exception', error)).finally(() => process.exit(1));
});

// Validate environment
validateEnv();

// Create Express app
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

// Initialize database
initializeDatabase(app);

// Set up middleware
const { setupMiddleware } = require('./config/middleware');
setupMiddleware(app);

// Mount routes
const { mountRoutes } = require('./config/routes');
const routeHandles = mountRoutes(app);

// Start server
const server = app.listen(PORT, () => {
  logger.info(`[server] ELYVN bridge running on port ${PORT}`);
  initializeServer(app, server, routeHandles);
});

module.exports = app;
