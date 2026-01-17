// CRITICAL: Initialize runId FIRST before any logger imports
// This ensures all CSV files use the same run ID
import { getRunId } from './utils/runId';
getRunId(); // Initialize runId immediately

import * as readline from 'readline';
import * as dotenv from 'dotenv';
import * as net from 'net';

// Load .env file first (before any other imports that might use ENV)
dotenv.config();

// Show interactive menu BEFORE importing ENV (which validates and requires certain vars)
// This allows us to set TRACK_ONLY_MODE before validation runs
async function showModeMenu(): Promise<'PAPER' | 'WATCH' | 'TRADING'> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (query: string): Promise<string> => {
        return new Promise((resolve) => rl.question(query, resolve));
    };

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║           🚀 EDGEBOT - MODE SELECTION                        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
    
    console.log('Select mode:');
    console.log('  1. 📊 Paper Mode - Independent paper trading (simulated)');
    console.log('  2. 👀 Watcher Mode - Monitor trader activity (read-only)');
    console.log('  3. 💰 Trading Mode - Real trading (executes trades)\n');

    while (true) {
        const choice = await question('Enter choice (1-3): ');
        const trimmed = choice.trim();

        if (trimmed === '1') {
            process.env.PAPER_MODE = 'true';
            process.env.TRACK_ONLY_MODE = 'false';
            rl.close();
            return 'PAPER';
        } else if (trimmed === '2') {
            process.env.PAPER_MODE = 'false';
            process.env.TRACK_ONLY_MODE = 'true';
            rl.close();
            return 'WATCH';
        } else if (trimmed === '3') {
            process.env.PAPER_MODE = 'false';
            process.env.TRACK_ONLY_MODE = 'false';
            rl.close();
            return 'TRADING';
        } else {
            console.log('❌ Invalid choice. Please enter 1, 2, or 3.\n');
        }
    }
}

// Don't import modules that use ENV at top level - import them dynamically in main() after menu

// Graceful shutdown handler
let isShuttingDown = false;

// Graceful shutdown will be set up in main() after imports
let gracefulShutdown: (signal: string) => Promise<void>;

// Optional web dashboard server instance (initialized in main)
type AppServerInstance = {
    start: () => Promise<void> | void;
    stop: () => void;
    getPort?: () => number;
};
let appServer: AppServerInstance | null = null;

async function findAvailablePort(preferredPort: number): Promise<number> {
    const isPortFree = (): Promise<boolean> => {
        return new Promise((resolve) => {
            const tester = net.createServer();

            tester.once('error', () => {
                resolve(false);
            });

            tester.once('listening', () => {
                tester.close(() => resolve(true));
            });

            try {
                tester.listen(preferredPort);
            } catch {
                resolve(false);
            }
        });
    };

    if (await isPortFree()) {
        return preferredPort;
    }

    return new Promise((resolve) => {
        const server = net.createServer();

        server.once('error', () => {
            resolve(preferredPort);
        });

        server.once('listening', () => {
            const address = server.address();
            const port =
                address && typeof address === 'object' ? address.port : preferredPort;
            server.close(() => resolve(port));
        });

        try {
            server.listen(0);
        } catch {
            resolve(preferredPort);
        }
    });
}

// Optional external bot metrics reporter interval
let botMetricsInterval: NodeJS.Timeout | null = null;

// Signal handlers will be set up in main() after imports

export const main = async () => {
    // Check if mode is explicitly set and show menu if not
    const hasExplicitMode = 
        (process.env.PAPER_MODE !== undefined && process.env.PAPER_MODE !== '') ||
        (process.env.TRACK_ONLY_MODE !== undefined && process.env.TRACK_ONLY_MODE !== '');

    const hasExplicitFlag = process.argv.some(arg => 
        arg.includes('PAPER_MODE') || arg.includes('TRACK_ONLY_MODE')
    );
    
    // Show menu if no mode is explicitly set
    if (!hasExplicitMode && !hasExplicitFlag) {
        const selectedMode = await showModeMenu();
        console.log(`\n✅ Selected: ${selectedMode === 'PAPER' ? '📊 Paper Mode' : selectedMode === 'WATCH' ? '👀 Watcher Mode' : '💰 Trading Mode'}\n`);
    }
    
    // NOW import all modules that use ENV (after menu has set TRACK_ONLY_MODE)
    const envModule = await import('./config/env');
    const ENV = envModule.ENV;
    const axiosModule = await import('axios');
    const axios = axiosModule.default;
    const dbModule = await import('./config/db');
    const connectDB = dbModule.default;
    const closeDB = dbModule.closeDB;
    const createClobClientModule = await import('./utils/createClobClient');
    const createClobClient = createClobClientModule.default;
    const tradeExecutorModule = await import('./services/tradeExecutor');
    const tradeExecutor = tradeExecutorModule.default;
    const stopTradeExecutor = tradeExecutorModule.stopTradeExecutor;
    const tradeMonitorModule = await import('./services/tradeMonitor');
    const tradeMonitor = tradeMonitorModule.default;
    const stopTradeMonitor = tradeMonitorModule.stopTradeMonitor;
    const paperTradeMonitorModule = await import('./services/paperTradeMonitor');
    const paperTradeMonitor = paperTradeMonitorModule.default;
    const stopPaperTradeMonitor = paperTradeMonitorModule.stopPaperTradeMonitor;
    const positionCloserModule = await import('./services/positionCloser');
    const closeMarketPositions = positionCloserModule.closeMarketPositions;
    const loggerModule = await import('./utils/logger');
    const Logger = loggerModule.default;
    const healthCheckModule = await import('./utils/healthCheck');
    const performHealthCheck = healthCheckModule.performHealthCheck;
    const logHealthCheck = healthCheckModule.logHealthCheck;
    const marketTrackerModule = await import('./services/marketTracker');
    const marketTracker = marketTrackerModule.default;
    await import('./services/tradeLogger');
    await import('./services/priceStreamLogger');

    // Optional web dashboard (reuses marketTracker + priceStreamLogger)
    if (ENV.ENABLE_WEB_DASHBOARD) {
        try {
            const appModule = await import('../app/server');
            const AppServer = appModule.AppServer as {
                new (port: number): AppServerInstance;
            };
            const portToUse = await findAvailablePort(ENV.WEB_DASHBOARD_PORT);
            appServer = new AppServer(portToUse);
            await appServer.start();
            const loggerModuleDashboard = await import('./utils/logger');
            const LoggerDashboard = loggerModuleDashboard.default;
            const actualPort =
                typeof appServer.getPort === 'function'
                    ? appServer.getPort()
                    : portToUse;
            LoggerDashboard.info(
                `Web dashboard running at http://localhost:${actualPort}`
            );
        } catch (error) {
            const loggerModuleDashboard = await import('./utils/logger');
            const LoggerDashboard = loggerModuleDashboard.default;
            LoggerDashboard.warning(
                `Failed to start web dashboard: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    // Initialize web app publisher to push updates to external dashboard
    try {
        const { initWebAppPublisher } = await import('./services/webAppPublisher');
        initWebAppPublisher();
    } catch (error) {
        Logger.warning(`Failed to initialize web app publisher: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    const USER_ADDRESSES = ENV.USER_ADDRESSES;
    const PROXY_WALLET = ENV.PROXY_WALLET;
    
    // Set up graceful shutdown now that we have the imports
    gracefulShutdown = async (signal: string) => {
        if (isShuttingDown) {
            Logger.warning('Shutdown already in progress, forcing exit...');
            process.exit(1);
        }

        isShuttingDown = true;
        Logger.separator();
        Logger.info(`Received ${signal}, initiating graceful shutdown...`);

        try {
            // Stop services
            stopTradeMonitor();
            stopPaperTradeMonitor();
            stopTradeExecutor();
            if (botMetricsInterval) {
                clearInterval(botMetricsInterval);
                botMetricsInterval = null;
            }
            if (appServer) {
                appServer.stop();
            }

            // Stop command handler and watchlist manager
            try {
                const commandHandlerModule = await import('./services/commandHandler');
                commandHandlerModule.default.stop();
                const watchlistManagerModule = await import('./services/watchlistManager');
                watchlistManagerModule.default.stop();
            } catch {
                // Ignore if not loaded
            }

            // Give services time to finish current operations
            Logger.info('Waiting for services to finish current operations...');
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Close database connection
            await closeDB();

            Logger.success('Graceful shutdown completed');
            process.exit(0);
        } catch (error) {
            Logger.error(`Error during shutdown: ${error}`);
            process.exit(1);
        }
    };
    
    // Set up signal handlers
    process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
        Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
        // Don't exit immediately, let the application try to recover
    });

    process.on('uncaughtException', (error: Error) => {
        Logger.error(`Uncaught Exception: ${error.message}`);
        // Exit immediately for uncaught exceptions as the application is in an undefined state
        gracefulShutdown('uncaughtException').catch(() => {
            process.exit(1);
        });
    });

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
    try {
        // Welcome message for first-time users
        const colors = {
            reset: '\x1b[0m',
            yellow: '\x1b[33m',
            cyan: '\x1b[36m',
        };
        
        console.log(`\n${colors.yellow}💡 First time running the bot?${colors.reset}`);
        console.log(`   Read the guide: ${colors.cyan}GETTING_STARTED.md${colors.reset}`);
        console.log(`   Run health check: ${colors.cyan}npm run health-check${colors.reset}\n`);
        
        await connectDB();
        Logger.startup(USER_ADDRESSES, ENV.TRACK_ONLY_MODE ? '' : PROXY_WALLET);

        // Perform initial health check
        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);

        if (!healthResult.healthy) {
            Logger.warning('Health check failed, but continuing startup...');
        }

        Logger.separator();
        
        // Set up market close callback for position closing
        let clobClientForClosing: Awaited<ReturnType<typeof createClobClient>> | null = null;
        
        // Only initialize CLOB client if we're in trading mode (not watcher or paper mode)
        if (!ENV.TRACK_ONLY_MODE && !ENV.PAPER_MODE) {
            Logger.info('Initializing CLOB client...');
            clobClientForClosing = await createClobClient();
            Logger.success('CLOB client ready');
        }
        
        // Set up callback for closing positions when markets are switched
        marketTracker.setMarketCloseCallback(async (market) => {
            await closeMarketPositions(clobClientForClosing, market);
        });
        
        // Verify CSV files exist (they should be created by logger constructors)
        const runId = getRunId();
        const path = await import('path');
        const fs = await import('fs');
        const logsDir = path.join(process.cwd(), 'logs');
        
        // Ensure logs directory exists
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        
        // CSV files organized by folder structure
        const livePricesDir = path.join(logsDir, 'Live prices');
        const watcherDir = path.join(logsDir, 'watcher');
        const paperDir = path.join(logsDir, 'paper');
        
        // Ensure all directories exist
        if (!fs.existsSync(livePricesDir)) {
            fs.mkdirSync(livePricesDir, { recursive: true });
        }
        if (!fs.existsSync(watcherDir)) {
            fs.mkdirSync(watcherDir, { recursive: true });
        }
        if (!fs.existsSync(paperDir)) {
            fs.mkdirSync(paperDir, { recursive: true });
        }
        
        const csvFilesByCategory = {
            'Live prices (Universal)': {
                dir: livePricesDir,
                files: [
                    { name: `BTC - 15 min prices_${runId}.csv`, desc: 'BTC 15min prices' },
                    { name: `ETH - 15 min prices_${runId}.csv`, desc: 'ETH 15min prices' },
                    { name: `BTC - 1 hour prices_${runId}.csv`, desc: 'BTC 1hr prices' },
                    { name: `ETH - 1 hour prices_${runId}.csv`, desc: 'ETH 1hr prices' },
                ],
            },
            'watcher': {
                dir: watcherDir,
                files: [
                    { name: `Watcher Trades_${runId}.csv`, desc: 'Watcher trades' },
                    { name: `Watcher Market PNL_${runId}.csv`, desc: 'Watcher market PnL' },
                ],
            },
            'paper': {
                dir: paperDir,
                files: [
                    { name: `Paper Trades_${runId}.csv`, desc: 'Paper trades' },
                    { name: `Paper Market PNL_${runId}.csv`, desc: 'Paper market PnL' },
                ],
            },
        };

        Logger.separator();
        Logger.info('📁 CSV LOGGING INITIALIZED');
        Logger.info('   Run ID: ' + runId);
        Logger.info('   Base Location: ' + logsDir);
        Logger.info('');

        let createdCount = 0;
        let totalCount = 0;

        // Display by category/folder
        for (const [category, categoryData] of Object.entries(csvFilesByCategory)) {
            // Skip paper trading files if not in paper mode
            if (category === 'paper' && !ENV.PAPER_MODE) {
                continue;
            }

            Logger.info(`   📂 ${category}/:`);
            for (const file of categoryData.files) {
                totalCount++;
                const filePath = path.join(categoryData.dir, file.name);
                const exists = fs.existsSync(filePath);
                if (exists) {
                    createdCount++;
                    Logger.info(`     ✓ ${file.desc}: ${file.name}`);
                } else {
                    Logger.warning(`     ○ ${file.desc}: ${file.name} (pending)`);
                }
            }
        }

        Logger.info('');
        if (createdCount === totalCount) {
            Logger.success(`   All ${totalCount} CSV files ready`);
        } else {
            Logger.info(`   ${createdCount}/${totalCount} CSV files created (others will be created on first log)`);
        }
        Logger.info('   Note: Price streams label Watch/Paper entries for cross-referencing');
        Logger.separator();
        
        // Determine which mode to run
        if (ENV.PAPER_MODE) {
            // Paper trading mode - discovers markets independently using same criteria as watcher
            Logger.info('Starting paper trade monitor...');
            Logger.separator();
            Logger.info('📊 PAPER MODE ACTIVATED');
            Logger.info('📊 Trading on same markets as watcher mode (discovered independently)');
            Logger.info('📈 Shows real-time PnL, positions, and market statistics');
            Logger.info('💾 Paper trades logged to logs/paper/Paper Trades_' + runId + '.csv');
            Logger.info('💾 Paper PnL logged to logs/paper/Paper Market PNL_' + runId + '.csv');
            Logger.info('💾 Prices logged to logs/Live prices/*_prices_' + runId + '.csv');
            Logger.info('');
            Logger.info('Paper trading: Independent strategy, trades on same market types as watcher');
            Logger.separator();
            paperTradeMonitor();

            // Start external bot performance reporter for WEBAPP dashboard (same as WATCH mode)
            try {
                const watcherPnLTrackerModule = await import('./services/watcherPnLTracker');
                const watcherPnLTracker = watcherPnLTrackerModule.default;

                // Import appState setters for syncing data to webAppPublisher
                const appStateModule = await import('./services/appState');
                const { setMarketSummaries, setPnlHistory } = appStateModule;

                botMetricsInterval = setInterval(async () => {
                    try {
                        const snapshot = watcherPnLTracker.getDashboardSnapshot();

                        // Sync data to appState for webAppPublisher
                        const pnlHistoryForAppState = snapshot.pnlHistory.map((entry) => {
                            const hasTimeRange = entry.marketName.match(/\d{1,2}:\d{2}(AM|PM)-\d{1,2}:\d{2}(AM|PM)/i);
                            const is15Min = hasTimeRange !== null;
                            const marketType: '5m' | '15m' | '1h' | 'OTHER' = is15Min ? '15m' : '15m';

                            return {
                                marketName: entry.marketName,
                                totalPnL: entry.totalPnl,
                                pnlPercent: entry.pnlPercent,
                                outcome: entry.outcome as 'UP' | 'DOWN',
                                timestamp: entry.timestamp,
                                marketType,
                                conditionId: entry.conditionId || '',
                            };
                        });

                        setPnlHistory(pnlHistoryForAppState);

                        const botId = 'edgebotpro';
                        const botName = 'EdgeBotPro';
                        const payload = {
                            botId,
                            botName,
                            apiKey: 'betabot-dashboard-key',
                            portfolio: {
                                balance: 0,
                                totalInvested: snapshot.totalInvested,
                                totalPnL: snapshot.totalPnL,
                                totalPnLPercent: snapshot.totalInvested > 0 ? (snapshot.totalPnL / snapshot.totalInvested) * 100 : 0,
                                totalTrades: snapshot.totalTrades,
                                pnl15m: snapshot.pnl15m,
                                pnl15mPercent: snapshot.pnl15mPercent,
                                trades15m: snapshot.trades15m,
                                pnl1h: snapshot.pnl1h,
                                pnl1hPercent: snapshot.pnl1hPercent,
                                trades1h: snapshot.trades1h,
                            },
                            pnlHistory: snapshot.pnlHistory.map((entry) => ({
                                marketName: entry.marketName,
                                conditionId: entry.conditionId || '',
                                totalPnl: entry.totalPnl,
                                pnlPercent: entry.pnlPercent,
                                priceUp: entry.priceUp || 0,
                                priceDown: entry.priceDown || 0,
                                sharesUp: entry.sharesUp || 0,
                                sharesDown: entry.sharesDown || 0,
                                outcome: entry.outcome,
                                timestamp: entry.timestamp,
                                marketType: '15m',
                            })),
                            currentMarkets: [],
                        };

                        const metricsUrl = process.env.BOT_METRICS_URL || 'http://localhost:3000/api/bot';
                        await axios.post(metricsUrl, payload, {
                            headers: { 'Content-Type': 'application/json' },
                        });
                    } catch (err) {
                        Logger.warning(`Failed to send paper metrics to dashboard: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }, 1500);
                Logger.info('Paper mode metrics reporter started');
            } catch (err) {
                Logger.warning(`Failed to initialize paper mode metrics reporter: ${err instanceof Error ? err.message : String(err)}`);
            }
        } else if (ENV.TRACK_ONLY_MODE) {
            // Watch mode
            Logger.info('Starting trade monitor...');
            tradeMonitor();
            Logger.separator();
            Logger.info('👀 WATCH MODE ACTIVATED');
            Logger.info('📊 Dashboard will display trader activity on up to 4 markets');
            Logger.info('📈 Shows real-time PnL, positions, and market statistics');
            Logger.info('💾 All trades logged to logs/watcher/Watcher Trades_' + runId + '.csv');
            Logger.info('💾 Market PnL logged to logs/watcher/Watcher Market PNL_' + runId + '.csv');
            Logger.info('💾 Prices logged to logs/Live prices/*_prices_' + runId + '.csv');
            Logger.info('');
            Logger.info('Trade executor disabled - monitoring only, no execution');
            Logger.info('');
            Logger.info('📋 WATCHLIST COMMANDS: /add <addr>, /remove <addr>, /list, /help');
            Logger.separator();

            // Start command handler for interactive watchlist management
            const commandHandlerModule = await import('./services/commandHandler');
            const commandHandler = commandHandlerModule.default;
            commandHandler.start();

            // Start external bot performance reporter for BETABOT dashboard
            try {
                const watcherPnLTrackerModule = await import('./services/watcherPnLTracker');
                const watcherPnLTracker = watcherPnLTrackerModule.default;
                let dashboardDataCollector: any = null;

                // Try to use the existing dashboard data collector to get currentMarkets
                try {
                    const appModule = await import('../app/server');
                    dashboardDataCollector = appModule.dashboardDataCollector;
                } catch (dashboardErr) {
                    Logger.warning(
                        `Dashboard data collector unavailable for external bot metrics: ${
                            dashboardErr instanceof Error ? dashboardErr.message : String(dashboardErr)
                        }`
                    );
                }

                // Import appState setters for syncing data to webAppPublisher
                const appStateModule = await import('./services/appState');
                const { setMarketSummaries, setPnlHistory } = appStateModule;

                botMetricsInterval = setInterval(async () => {
                    try {
                        // Get snapshot before recording investment (to get current investment data)
                        const snapshot = watcherPnLTracker.getDashboardSnapshot();

                        // Build currentMarkets payload using dashboard data (if available)
                        let currentMarkets: {
                            marketKey: string;
                            marketName: string;
                            category: string;
                            endDate: number | null;
                            timeRemaining: string;
                            isExpired: boolean;
                            priceUp: number | null;
                            priceDown: number | null;
                            sharesUp: number;
                            sharesDown: number;
                            investedUp: number;
                            investedDown: number;
                            totalCostUp: number;
                            totalCostDown: number;
                            currentValueUp: number;
                            currentValueDown: number;
                            pnlUp: number;
                            pnlDown: number;
                            pnlUpPercent: number;
                            pnlDownPercent: number;
                            totalPnL: number;
                            totalPnLPercent: number;
                            tradesUp: number;
                            tradesDown: number;
                            upPercent: number;
                            downPercent: number;
                        }[] = [];

                        // Portfolio snapshot from dashboard (live/open PnL)
                        let dashboardPortfolio: any | null = null;

                        // Calculate unrealized PnL from active positions
                        let unrealizedPnL = 0;
                        let unrealizedInvested = 0;
                        let unrealizedTrades = 0;
                        let unrealizedPnL15m = 0;
                        let unrealizedInvested15m = 0;
                        let unrealizedTrades15m = 0;
                        let unrealizedPnL1h = 0;
                        let unrealizedInvested1h = 0;
                        let unrealizedTrades1h = 0;

                        // Use dashboardDataCollector to get EXACT same data as local dashboard
                        // This ensures external web dashboard matches local dashboard display
                        try {
                            if (dashboardDataCollector) {
                                const dashboardUpdate = dashboardDataCollector.getDashboardUpdate();
                                dashboardPortfolio = dashboardUpdate.data.portfolio || null;

                                // Use currentMarkets + upcomingMarkets from dashboard (same as local display)
                                const allDashboardMarkets = [
                                    ...dashboardUpdate.data.currentMarkets,
                                    ...dashboardUpdate.data.upcomingMarkets,
                                ];

                                currentMarkets = allDashboardMarkets.map((m) => {
                                    // Calculate unrealized PnL for portfolio stats
                                    const hasValidPriceUp =
                                        m.priceUp !== undefined &&
                                        m.priceUp !== null &&
                                        m.priceUp > 0 &&
                                        m.priceUp < 1;
                                    const hasValidPriceDown =
                                        m.priceDown !== undefined &&
                                        m.priceDown !== null &&
                                        m.priceDown > 0 &&
                                        m.priceDown < 1;
                                    const hasValidPrices = hasValidPriceUp || hasValidPriceDown;

                                    const marketUnrealizedPnL = hasValidPrices ? (m.totalPnL || 0) : 0;
                                    const marketInvested = hasValidPrices
                                        ? (m.investedUp || 0) + (m.investedDown || 0)
                                        : 0;
                                    const marketTrades = (m.tradesUp || 0) + (m.tradesDown || 0);

                                    unrealizedPnL += marketUnrealizedPnL;
                                    unrealizedInvested += marketInvested;
                                    unrealizedTrades += marketTrades;

                                    // Categorize by market type
                                    const marketKey = m.marketKey || '';
                                    if (marketKey.includes('-15') || m.category?.includes('15m')) {
                                        unrealizedPnL15m += marketUnrealizedPnL;
                                        unrealizedInvested15m += marketInvested;
                                        unrealizedTrades15m += marketTrades;
                                    } else if (marketKey.includes('-1h') || m.category?.includes('1h')) {
                                        unrealizedPnL1h += marketUnrealizedPnL;
                                        unrealizedInvested1h += marketInvested;
                                        unrealizedTrades1h += marketTrades;
                                    }

                                    return {
                                        marketKey: m.marketKey,
                                        marketName: m.marketName,
                                        category: m.category,
                                        endDate: m.endDate ?? null,
                                        timeRemaining: m.timeRemaining,
                                        isExpired: m.isExpired || false,
                                        priceUp: m.priceUp,
                                        priceDown: m.priceDown,
                                        sharesUp: m.sharesUp,
                                        sharesDown: m.sharesDown,
                                        investedUp: m.investedUp,
                                        investedDown: m.investedDown,
                                        totalCostUp: m.totalCostUp,
                                        totalCostDown: m.totalCostDown,
                                        currentValueUp: m.currentValueUp || 0,
                                        currentValueDown: m.currentValueDown || 0,
                                        pnlUp: m.pnlUp,
                                        pnlDown: m.pnlDown,
                                        pnlUpPercent: m.pnlUpPercent || 0,
                                        pnlDownPercent: m.pnlDownPercent || 0,
                                        totalPnL: m.totalPnL,
                                        totalPnLPercent: m.totalPnLPercent || 0,
                                        tradesUp: m.tradesUp,
                                        tradesDown: m.tradesDown,
                                        upPercent: m.upPercent || 50,
                                        downPercent: m.downPercent || 50,
                                    };
                                });
                            } else {
                                // Fallback to marketTracker if dashboardDataCollector unavailable
                                const markets = marketTracker.getMarketsForWebApp();
                                currentMarkets = markets.map((m) => {
                                    const hasValidPriceUp =
                                        m.priceUp !== undefined &&
                                        m.priceUp > 0 &&
                                        m.priceUp < 1;
                                    const hasValidPriceDown =
                                        m.priceDown !== undefined &&
                                        m.priceDown > 0 &&
                                        m.priceDown < 1;
                                    const hasValidPrices = hasValidPriceUp || hasValidPriceDown;

                                    const marketUnrealizedPnL = hasValidPrices ? (m.totalPnL || 0) : 0;
                                    const marketInvested = hasValidPrices
                                        ? (m.investedUp || 0) + (m.investedDown || 0)
                                        : 0;
                                    const marketTrades = (m.tradesUp || 0) + (m.tradesDown || 0);

                                    unrealizedPnL += marketUnrealizedPnL;
                                    unrealizedInvested += marketInvested;
                                    unrealizedTrades += marketTrades;

                                    const marketKey = m.marketKey || '';
                                    if (marketKey.includes('-15')) {
                                        unrealizedPnL15m += marketUnrealizedPnL;
                                        unrealizedInvested15m += marketInvested;
                                        unrealizedTrades15m += marketTrades;
                                    } else if (marketKey.includes('-1h')) {
                                        unrealizedPnL1h += marketUnrealizedPnL;
                                        unrealizedInvested1h += marketInvested;
                                        unrealizedTrades1h += marketTrades;
                                    }

                                    return {
                                        marketKey: m.marketKey,
                                        marketName: m.marketName,
                                        category: m.category,
                                        endDate: m.endDate ?? null,
                                        timeRemaining: m.timeRemaining,
                                        isExpired: m.isExpired || false,
                                        priceUp: m.priceUp || null,
                                        priceDown: m.priceDown || null,
                                        sharesUp: m.sharesUp,
                                        sharesDown: m.sharesDown,
                                        investedUp: m.investedUp,
                                        investedDown: m.investedDown,
                                        totalCostUp: m.investedUp,
                                        totalCostDown: m.investedDown,
                                        currentValueUp: m.currentValueUp || 0,
                                        currentValueDown: m.currentValueDown || 0,
                                        pnlUp: m.pnlUp,
                                        pnlDown: m.pnlDown,
                                        pnlUpPercent: m.pnlUpPercent || 0,
                                        pnlDownPercent: m.pnlDownPercent || 0,
                                        totalPnL: m.totalPnL,
                                        totalPnLPercent: m.totalPnLPercent || 0,
                                        tradesUp: m.tradesUp,
                                        tradesDown: m.tradesDown,
                                        upPercent: m.upPercent || 50,
                                        downPercent: m.downPercent || 50,
                                    };
                                });
                            }
                        } catch (collectErr) {
                            Logger.warning(
                                `Failed to collect current markets for external bot metrics: ${
                                    collectErr instanceof Error ? collectErr.message : String(collectErr)
                                }`
                            );
                        }

                        // Record investment snapshot for average calculation
                        // This tracks concurrent investment over time
                        watcherPnLTracker.recordInvestmentSnapshot(unrealizedInvested);

                        // Combine realized (closed markets) + unrealized (active markets) PnL
                        const combinedTotalPnL = snapshot.totalPnL + unrealizedPnL;
                        const combinedTotalInvested = snapshot.totalInvested + unrealizedInvested;
                        const combinedTotalTrades = snapshot.totalTrades + unrealizedTrades;
                        const combinedBalance = combinedTotalInvested + combinedTotalPnL;
                        const combinedTotalPnLPercent =
                            combinedTotalInvested > 0
                                ? (combinedTotalPnL / combinedTotalInvested) * 100
                                : 0;

                        // Combine 15m stats
                        const combinedPnL15m = snapshot.pnl15m + unrealizedPnL15m;
                        const combined15mInvested =
                            (snapshot.pnl15mPercent !== 0 && snapshot.pnl15m !== 0
                                ? (snapshot.pnl15m / snapshot.pnl15mPercent) * 100
                                : 0) + unrealizedInvested15m;
                        const combinedPnL15mPercent =
                            combined15mInvested > 0 ? (combinedPnL15m / combined15mInvested) * 100 : 0;
                        const combinedTrades15m = snapshot.trades15m + unrealizedTrades15m;

                        // Combine 1h stats
                        const combinedPnL1h = snapshot.pnl1h + unrealizedPnL1h;
                        const combined1hInvested =
                            (snapshot.pnl1hPercent !== 0 && snapshot.pnl1h !== 0
                                ? (snapshot.pnl1h / snapshot.pnl1hPercent) * 100
                                : 0) + unrealizedInvested1h;
                        const combinedPnL1hPercent =
                            combined1hInvested > 0 ? (combinedPnL1h / combined1hInvested) * 100 : 0;
                        const combinedTrades1h = snapshot.trades1h + unrealizedTrades1h;

                        // Choose portfolio metrics for external dashboard:
                        // - Prefer live/open PnL from dashboardDataCollector (matches terminal dashboard)
                        // - Fallback to combined (realized + unrealized) if dashboard portfolio unavailable
                        let balance: number;
                        let totalInvested: number;
                        let totalPnL: number;
                        let totalPnLPercent: number;
                        let totalTrades: number;
                        let pnl15m: number;
                        let pnl15mPercent: number;
                        let trades15m: number;
                        let pnl1h: number;
                        let pnl1hPercent: number;
                        let trades1h: number;

                        if (dashboardPortfolio) {
                            balance = dashboardPortfolio.totalValue ?? 0;
                            // Use cost basis for percent calculation, but expose both invested+value via fields below
                            totalInvested = dashboardPortfolio.totalCostBasis ?? 0;
                            totalPnL = dashboardPortfolio.totalPnL ?? 0;
                            totalPnLPercent = dashboardPortfolio.totalPnLPercent ?? 0;
                            totalTrades = dashboardPortfolio.totalTrades ?? 0;

                            pnl15m = dashboardPortfolio.pnl15m ?? 0;
                            pnl15mPercent = dashboardPortfolio.pnl15mPercent ?? 0;
                            trades15m = dashboardPortfolio.trades15m ?? 0;

                            pnl1h = dashboardPortfolio.pnl1h ?? 0;
                            pnl1hPercent = dashboardPortfolio.pnl1hPercent ?? 0;
                            trades1h = dashboardPortfolio.trades1h ?? 0;
                        } else {
                            balance = combinedBalance;
                            totalInvested = combinedTotalInvested;
                            totalPnL = combinedTotalPnL;
                            totalPnLPercent = combinedTotalPnLPercent;
                            totalTrades = combinedTotalTrades;

                            pnl15m = combinedPnL15m;
                            pnl15mPercent = combinedPnL15mPercent;
                            trades15m = combinedTrades15m;

                            pnl1h = combinedPnL1h;
                            pnl1hPercent = combinedPnL1hPercent;
                            trades1h = combinedTrades1h;
                        }

                        // Calculate live PnL percent
                        const livePnLPercent =
                            unrealizedInvested > 0
                                ? (unrealizedPnL / unrealizedInvested) * 100
                                : 0;
                        const livePnL15mPercent =
                            unrealizedInvested15m > 0
                                ? (unrealizedPnL15m / unrealizedInvested15m) * 100
                                : 0;
                        const livePnL1hPercent =
                            unrealizedInvested1h > 0
                                ? (unrealizedPnL1h / unrealizedInvested1h) * 100
                                : 0;

                        // Sync data to appState so webAppPublisher can send it
                        // This ensures both /api/bot and /api/update endpoints have the same data
                        const marketSummariesForAppState = currentMarkets.map((m) => ({
                            marketKey: m.marketKey,
                            marketName: m.marketName,
                            category: m.category,
                            endDate: m.endDate ?? undefined,
                            timeRemaining: m.timeRemaining,
                            isExpired: m.isExpired,
                            priceUp: m.priceUp ?? 0,
                            priceDown: m.priceDown ?? 0,
                            sharesUp: m.sharesUp,
                            sharesDown: m.sharesDown,
                            investedUp: m.investedUp,
                            investedDown: m.investedDown,
                            currentValueUp: m.currentValueUp,
                            currentValueDown: m.currentValueDown,
                            pnlUp: m.pnlUp,
                            pnlDown: m.pnlDown,
                            pnlUpPercent: m.pnlUpPercent,
                            pnlDownPercent: m.pnlDownPercent,
                            totalPnL: m.totalPnL,
                            totalPnLPercent: m.totalPnLPercent,
                            tradesUp: m.tradesUp,
                            tradesDown: m.tradesDown,
                            upPercent: m.upPercent,
                            downPercent: m.downPercent,
                        }));

                        const pnlHistoryForAppState = snapshot.pnlHistory.map((entry) => {
                            const hasTimeRange = entry.marketName.match(/\d{1,2}:\d{2}(AM|PM)-\d{1,2}:\d{2}(AM|PM)/i);
                            const is15Min = hasTimeRange !== null;
                            const is1Hour =
                                (entry.marketName.includes('Bitcoin Up or Down') ||
                                    entry.marketName.includes('Ethereum Up or Down')) &&
                                !is15Min &&
                                entry.marketName.match(/\d{1,2}(AM|PM) ET/i) !== null;
                            const marketType: '5m' | '15m' | '1h' | 'OTHER' = is15Min ? '15m' : is1Hour ? '1h' : '15m';

                            return {
                                marketName: entry.marketName,
                                totalPnL: entry.totalPnl,
                                pnlPercent: entry.pnlPercent,
                                outcome: entry.outcome as 'UP' | 'DOWN',
                                timestamp: entry.timestamp,
                                marketType,
                                conditionId: entry.conditionId || '',
                            };
                        });

                        setMarketSummaries(marketSummariesForAppState);
                        setPnlHistory(pnlHistoryForAppState);

                        const botId = 'edgebotpro';
                        const botName = 'EdgeBotPro';
                        const payload = {
                            botId,
                            botName,
                            apiKey: 'betabot-dashboard-key',
                            portfolio: {
                                // Primary portfolio metrics (prefer live/open PnL to match terminal dashboard)
                                balance,
                                totalInvested,
                                totalPnL,
                                totalPnLPercent,
                                totalTrades,
                                pnl15m,
                                pnl15mPercent,
                                trades15m,
                                pnl1h,
                                pnl1hPercent,
                                trades1h,
                                // Live/Unrealized PnL (active positions only)
                                livePnL: unrealizedPnL,
                                livePnLPercent,
                                liveInvested: unrealizedInvested,
                                liveTrades: unrealizedTrades,
                                livePnL15m: unrealizedPnL15m,
                                livePnL15mPercent,
                                liveInvested15m: unrealizedInvested15m,
                                liveTrades15m: unrealizedTrades15m,
                                livePnL1h: unrealizedPnL1h,
                                livePnL1hPercent,
                                liveInvested1h: unrealizedInvested1h,
                                liveTrades1h: unrealizedTrades1h,
                                // Realized PnL (closed markets only)
                                realizedPnL: snapshot.totalPnL,
                                realizedPnLPercent: snapshot.totalInvested > 0
                                    ? (snapshot.totalPnL / snapshot.totalInvested) * 100
                                    : 0,
                                realizedInvested: snapshot.totalInvested,
                                realizedTrades: snapshot.totalTrades,
                                // Concurrent investment metrics
                                avgConcurrentInvestment: snapshot.avgConcurrentInvestment,
                                peakConcurrentInvestment: snapshot.peakConcurrentInvestment,
                            },
                            pnlHistory: snapshot.pnlHistory.map((entry) => {
                                // Determine marketType based on market name pattern
                                const hasTimeRange = entry.marketName.match(/\d{1,2}:\d{2}(AM|PM)-\d{1,2}:\d{2}(AM|PM)/i);
                                const is15Min = hasTimeRange !== null;
                                const is1Hour =
                                    (entry.marketName.includes('Bitcoin Up or Down') ||
                                        entry.marketName.includes('Ethereum Up or Down')) &&
                                    !is15Min &&
                                    entry.marketName.match(/\d{1,2}(AM|PM) ET/i) !== null;
                                const marketType: '15m' | '1h' = is15Min ? '15m' : is1Hour ? '1h' : '15m';

                                return {
                                    marketName: entry.marketName,
                                    conditionId: entry.conditionId || '',
                                    totalPnl: entry.totalPnl,
                                    pnlPercent: entry.pnlPercent,
                                    priceUp: entry.priceUp || 0,
                                    priceDown: entry.priceDown || 0,
                                    sharesUp: entry.sharesUp || 0,
                                    sharesDown: entry.sharesDown || 0,
                                    outcome: entry.outcome,
                                    timestamp: entry.timestamp,
                                    marketType,
                                };
                            }),
                            currentMarkets,
                        };

                        const metricsUrl = process.env.BOT_METRICS_URL;

                        // Only send metrics if BOT_METRICS_URL is explicitly configured
                        if (metricsUrl) {
                            await axios.post(metricsUrl, payload, {
                                headers: { 'Content-Type': 'application/json' },
                            });
                        }
                    } catch (err) {
                        Logger.warning(
                            `Failed to send watcher metrics to dashboard: ${
                                err instanceof Error ? err.message : String(err)
                            }`
                        );
                    }
                }, 1500); // Update every 1.5 seconds for real-time dashboard feel
            } catch (err) {
                Logger.warning(
                    `Failed to initialize watcher metrics reporter: ${
                        err instanceof Error ? err.message : String(err)
                    }`
                );
            }
        } else {
            // Real trading mode
            Logger.info('Starting trade monitor...');
            tradeMonitor();
            Logger.info('Starting trade executor...');
            tradeExecutor(clobClientForClosing!);
        }
    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

main();
