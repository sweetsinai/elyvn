# ELYVN n8n Workflows

This directory contains n8n workflow exports for monitoring the ELYVN production environment.

## Security Notice

All hardcoded secrets (Telegram Bot Tokens and Chat IDs) have been removed and replaced with placeholders. 

### Required Setup

Before importing these workflows into n8n, you must replace the following placeholders:

1. `REPLACE_WITH_TELEGRAM_BOT_TOKEN`: Your Telegram Bot API token (from @BotFather).
2. `REPLACE_WITH_TELEGRAM_CHAT_ID`: The Telegram Chat ID where alerts should be sent.

## Workflows

1. **ELYVN Heartbeat Monitor**: Checks `/health/ready` every 2 minutes. Alerts if the system is down.
2. **ELYVN Metrics Watchdog**: Checks `/health/detailed` every 10 minutes. Alerts if SMS success rate drops below 90% or response times exceed 1 second.
3. **ELYVN Deploy Verifier**: Checks version and health status hourly to ensure stability after deployments.
