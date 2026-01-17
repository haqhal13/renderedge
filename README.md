# Polymarket Copy Trading Bot

> Automated copy trading bot for Polymarket that mirrors trades from top performers with intelligent position sizing and real-time execution.

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

## Overview

The Polymarket Copy Trading Bot automatically replicates trades from successful Polymarket traders to your wallet. It monitors trader activity 24/7, calculates proportional position sizes based on your capital, and executes matching orders in real-time.

### How It Works
<img width="995" height="691" alt="screenshot" src="https://github.com/user-attachments/assets/79715c7a-de2c-4033-81e6-b2288963ec9b" />

1. **Select Traders** - Choose top performers from [Polymarket leaderboard](https://polymarket.com/leaderboard) or [Predictfolio](https://predictfolio.com)
2. **Monitor Activity** - Bot continuously watches for new positions opened by selected traders using Polymarket Data API
3. **Calculate Size** - Automatically scales trades based on your balance vs. trader's balance
4. **Execute Orders** - Places matching orders on Polymarket using your wallet
5. **Track Performance** - Maintains complete trade history in MongoDB

## Quick Start

### Prerequisites

- Node.js v18+
- MongoDB database ([MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) free tier works)
- Polygon wallet with USDC and POL/MATIC for gas
- RPC endpoint ([Infura](https://infura.io) or [Alchemy](https://www.alchemy.com) free tier)

### Installation

```bash
# Clone repository
git clone https://github.com/vladmeer/polymarket-copy-trading-bot.git
cd polymarket-copy-trading-bot

# Install dependencies
npm install

# Run interactive setup wizard
npm run setup

# Build and start
npm run build
npm run health-check  # Verify configuration
npm start             # Start bot (interactive mode selection)
```

When you run `npm start`, the bot automatically selects a mode. In CI/Render environments it defaults to **Watcher** mode, while in a local terminal you'll be prompted to choose Watcher or Trading.

You can also set the mode explicitly via environment variables:
```bash
MODE=WATCH npm start             # Force watcher mode (monitor only)
MODE=TRADING npm start           # Run in live trading mode
TRACK_ONLY_MODE=true npm start   # Legacy flag – also enables watcher mode
```

📌 **Paper mode has been removed** in this lightweight build. Use Watcher mode for dry-runs.

**📖 For detailed setup instructions, see [Getting Started Guide](./docs/GETTING_STARTED.md)**
**📖 For quick run instructions, see [Quick Run Guide](./README_RUN.md)**

## Features

- **Two Operating Modes** - Watcher (read-only) and Live trading with a shared code path
- **Multi-Trader Support** - Track and copy trades from multiple traders simultaneously
- **Smart Position Sizing** - Automatically adjusts trade sizes based on your capital
- **Tiered Multipliers** - Apply different multipliers based on trade size
- **Position Tracking** - Accurately tracks purchases and sells even after balance changes
- **Trade Aggregation** - Combines multiple small trades into larger executable orders
- **Real-time Execution** - Monitors trades every second and executes instantly
- **MongoDB Integration** - Persistent storage of all trades and positions
- **Price Protection** - Built-in slippage checks to avoid unfavorable fills
- **Web App Streaming** - Built-in HTTP API plus optional webhook pushes instead of CSV files

### Operating Modes

The lightweight build ships with two runtime modes:

1. **👀 Watcher Mode** – Monitor trader activity (read-only).
   - Tracks trader positions from the addresses in `USER_ADDRESSES`.
   - Streams every trade/position update to the console, `/state` API, and optional webhook.
   - Does not require a funded wallet or MongoDB (falls back to in-memory storage).

2. **💰 Trading Mode** – Real trading with automatic execution.
   - Mirrors selected traders and posts orders through the Polymarket CLOB client.
   - Shares all watcher telemetry so your web app sees identical data.
   - **⚠️ Uses real money – trade responsibly.**

📌 Paper mode has been removed to keep the runtime lean for Render deployments. Use Watcher mode for dry runs or connect the new web app API to visualize data without executing orders.

### Monitoring Method

The bot currently uses the **Polymarket Data API** to monitor trader activity and detect new positions. The monitoring system polls trader positions at configurable intervals (default: 1 second) to ensure timely trade detection and execution.

### Web App Integration

- **Built-in HTTP API** – Every deployment exposes `/health` and `/state` (JSON) so dashboards can poll without touching the filesystem.
- **Streaming dashboard** – Visit `/dashboard` (or subscribe to `/events`) to watch trades update live via server-sent events; works even if you never wire an external web app.
- **Push updates** – Set `WEBAPP_PUSH_URL` (and optional `WEBAPP_API_KEY`) to stream the latest snapshot to your own web service whenever trades, positions, or health data change.
- **Render-friendly** – The runtime no longer writes CSV files; everything is kept in memory and streamed over HTTP/webhooks.

## Configuration

### Easy Wallet Configuration 🎯

**The easiest way to set which wallet to track:** Just edit the `wallet` file!

```bash
# Open the wallet file
nano wallet
# or
code wallet
# or any text editor

# Replace the address with the wallet you want to track
0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d
```

The bot will automatically use the address from the `wallet` file. You can also:
- Add multiple addresses separated by commas: `0xABC..., 0xDEF...`
- Add comments with `#` for notes
- The bot prioritizes: `wallet` file → `USER_ADDRESSES` env var → default

**Priority order:**
1. `wallet` file (easiest - just edit and save!)
2. `USER_ADDRESSES` environment variable
3. Default address (0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d)

### Essential Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `USER_ADDRESSES` | Traders to copy (comma-separated) | `'0xABC..., 0xDEF...'` |
| `PROXY_WALLET` | Your Polygon wallet address | `'0x123...'` |
| `PRIVATE_KEY` | Wallet private key (no 0x prefix) | `'abc123...'` |
| `MONGO_URI` | MongoDB connection string | `'mongodb+srv://...'` |
| `RPC_URL` | Polygon RPC endpoint | `'https://polygon...'` |
| `TRADE_MULTIPLIER` | Position size multiplier (default: 1.0) | `2.0` |
| `FETCH_INTERVAL` | Check interval in seconds (default: 1) | `1` |

### Finding Traders

1. Visit [Polymarket Leaderboard](https://polymarket.com/leaderboard)
2. Look for traders with positive P&L, win rate >55%, and active trading history
3. Verify detailed stats on [Predictfolio](https://predictfolio.com)
4. Add wallet addresses to `USER_ADDRESSES`

**📖 For complete configuration guide, see [Quick Start](./docs/QUICK_START.md)**

## Docker Deployment

Deploy with Docker Compose for a production-ready setup:

```bash
# Configure and start
cp .env.example .env
docker-compose up -d

# View logs
docker-compose logs -f polymarket
```

**📖 [Complete Docker Guide →](./docs/DOCKER.md)**

## Render Deployment

This repo now ships with a [`render.yaml`](./render.yaml) specification so you can deploy the bot as a Render Web Service in a few clicks:

1. Push your fork to GitHub and create a new **Web Service** on Render.
2. Point Render to the repo and select the `render.yaml` blueprint. It automatically runs `npm install && npm run build` and then `npm start`.
3. Add the required environment variables (`USER_ADDRESSES`, `PROXY_WALLET`, `PRIVATE_KEY`, `MONGO_URI`, etc.). Set `MODE=WATCH` for monitoring-only environments or `MODE=TRADING` when you are ready to execute orders.
4. (Optional) Provide `WEBAPP_PUSH_URL`, `WEBAPP_API_KEY`, and `PORT` so your front-end can consume the `/state` endpoint or receive webhook pushes.

Render exposes the HTTP API publicly, making it simple to connect a lightweight React/Next dashboard or any webhook consumer that visualizes live bot data.

## Documentation

### Getting Started
- **[🚀 Getting Started Guide](./docs/GETTING_STARTED.md)** - Complete beginner's guide
- **[⚡ Quick Start](./docs/QUICK_START.md)** - Fast setup for experienced users
- **[🏃 Quick Run Guide](./README_RUN.md)** - How to run the bot and select modes

### Advanced Guides
- **[Multi-Trader Guide](./docs/MULTI_TRADER_GUIDE.md)** - Track multiple traders
- **[Simulation Guide](./docs/SIMULATION_GUIDE.md)** - Test strategies with simulations
- **[Position Tracking](./docs/POSITION_TRACKING.md)** - Understand position management
- **[Docker Deployment](./docs/DOCKER.md)** - Production deployment

## License

ISC License - See [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built on [Polymarket CLOB Client](https://github.com/Polymarket/clob-client)
- Uses [Predictfolio](https://predictfolio.com) for trader analytics
- Powered by Polygon network

---

## Advanced version

**🚀 Version 2 Available:** An advanced version with **RTDS (Real-Time Data Stream)** monitoring is now available as a private repository. <br />
Version 2 features the fastest trade detection method with near-instantaneous trade replication, lower latency, and reduced API load. Copy trading works excellently in the advanced version.

<img width="680" height="313" alt="image (19)" src="https://github.com/user-attachments/assets/d868f9f2-a1dd-4bfe-a76e-d8cbdfbd8497" />

## Trading tool

I've also developed a trading bot for Polymarket built with **Rust**.

<img width="1917" height="942" alt="image (21)" src="https://github.com/user-attachments/assets/08a5c962-7f8b-4097-98b6-7a457daa37c9" />
https://www.youtube.com/watch?v=4f6jHT4-DQs

**Disclaimer:** This software is for educational purposes only. Trading involves risk of loss. The developers are not responsible for any financial losses incurred while using this bot.

**Support:** For questions or issues, contact via Telegram: [@Vladmeer](https://t.me/vladmeer67) | Twitter: [@Vladmeer](https://x.com/vladmeer67)

# Trigger redeploy Sat Jan 17 03:33:29 GMT 2026
