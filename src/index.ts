// CRITICAL: Initialize runId FIRST before any logger imports
// This ensures all CSV files use the same run ID
import { getRunId } from './utils/runId';
getRunId(); // Initialize runId immediately

import * as readline from 'readline';
import * as dotenv from 'dotenv';

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
            Logger.separator();
        } else {
            // Real trading mode
            Logger.info('Starting trade monitor...');
            tradeMonitor();
            Logger.info('Starting trade executor...');
            tradeExecutor(clobClientForClosing!);
        }

        // test(clobClient);
    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

main();
