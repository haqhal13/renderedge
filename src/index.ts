// CRITICAL: Initialize runId FIRST before any logger imports
// This ensures all CSV files use the same run ID
import { getRunId } from './utils/runId';
getRunId(); // Initialize runId immediately

import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import { closeMarketPositions } from './services/positionCloser';
import Logger from './utils/logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';
import test from './test/test';
// Now import loggers (they will use the runId that was just initialized)
import marketTracker from './services/marketTracker';
import './services/tradeLogger';
import './services/priceStreamLogger';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PROXY_WALLET = ENV.PROXY_WALLET;

// Graceful shutdown handler
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
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

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    // Don't exit immediately, let the application try to recover
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
    Logger.error(`Uncaught Exception: ${error.message}`);
    // Exit immediately for uncaught exceptions as the application is in an undefined state
    gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
    });
});

// Handle termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export const main = async () => {
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
        
        if (!ENV.TRACK_ONLY_MODE) {
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
            // Skip paper trading files if in track-only mode
            if (category === 'paper' && ENV.TRACK_ONLY_MODE) {
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
        
        Logger.info('Starting trade monitor...');
        tradeMonitor();

        // Only start trade executor if not in track-only mode
        if (ENV.TRACK_ONLY_MODE) {
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
