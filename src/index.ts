import * as readline from 'readline';
import * as dotenv from 'dotenv';
import Logger from './utils/logger';
import { setRuntimeMode, setStatusMessage, setHealthSnapshot } from './services/appState';
import startAppServer from './server/appServer';

dotenv.config();

const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

const applyMode = (mode: 'WATCH' | 'TRADING'): void => {
    process.env.PAPER_MODE = 'false';
    process.env.TRACK_ONLY_MODE = mode === 'WATCH' ? 'true' : 'false';
};

const readModeFromEnv = (): 'WATCH' | 'TRADING' | null => {
    if (process.env.PAPER_MODE === 'true') {
        return 'WATCH';
    }

    if (process.env.MODE) {
        const normalized = process.env.MODE.toUpperCase();
        if (normalized === 'WATCH' || normalized === 'TRACK') {
            return 'WATCH';
        }
        if (normalized === 'TRADING' || normalized === 'LIVE') {
            return 'TRADING';
        }
    }

    if (process.env.TRACK_ONLY_MODE === 'true') {
        return 'WATCH';
    }
    if (process.env.TRACK_ONLY_MODE === 'false' && process.env.PROXY_WALLET) {
        return 'TRADING';
    }

    return null;
};

const promptForMode = async (): Promise<'WATCH' | 'TRADING'> => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (query: string): Promise<string> =>
        new Promise((resolve) => rl.question(query, resolve));

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║           🚀 EDGEBOT - MODE SELECTION                        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    console.log('Select mode:');
    console.log('  1. 👀 Watcher Mode - Monitor trader activity (read-only)');
    console.log('  2. 💰 Trading Mode - Real trading (executes trades)\n');

    while (true) {
        const choice = (await question('Enter choice (1-2): ')).trim();
        if (choice === '1') {
            rl.close();
            return 'WATCH';
        }
        if (choice === '2') {
            rl.close();
            return 'TRADING';
        }
        console.log('❌ Invalid choice. Please enter 1 or 2.\n');
    }
};

const resolveMode = async (): Promise<'WATCH' | 'TRADING'> => {
    const envMode = readModeFromEnv();
    if (envMode) {
        applyMode(envMode);
        return envMode;
    }

    if (isInteractive) {
        const selected = await promptForMode();
        applyMode(selected);
        return selected;
    }

    // Default to watch mode for non-interactive environments (Render, CI, etc.)
    applyMode('WATCH');
    return 'WATCH';
};

let gracefulShutdown: (signal: string) => Promise<void>;
let isShuttingDown = false;

export const main = async () => {
    const mode = await resolveMode();
    setStatusMessage('booting');

    const envModule = await import('./config/env');
    const ENV = envModule.ENV;
    const webPublisherModule = await import('./services/webAppPublisher');
    const publishAppState = webPublisherModule.default;
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
    const healthCheckModule = await import('./utils/healthCheck');
    const performHealthCheck = healthCheckModule.performHealthCheck;
    const logHealthCheck = healthCheckModule.logHealthCheck;

    if (ENV.PAPER_MODE) {
        Logger.error('Paper mode is no longer supported in the lightweight build.');
        process.exit(1);
    }

    setRuntimeMode(ENV.TRACK_ONLY_MODE ? 'TRACK_ONLY' : 'TRADING');
    Logger.info(`Runtime mode: ${mode === 'WATCH' ? 'Watcher' : 'Trading'}`);

    const appServer = await startAppServer();
    setStatusMessage('starting-database');

    // Set up graceful shutdown after we have the references
    gracefulShutdown = async (signal: string) => {
        if (isShuttingDown) {
            Logger.warning('Shutdown already in progress, forcing exit...');
            process.exit(1);
        }
        isShuttingDown = true;
        Logger.separator();
        Logger.info(`Received ${signal}, initiating graceful shutdown...`);

        try {
            stopTradeMonitor();
            stopTradeExecutor();
            setStatusMessage('stopping');

            await new Promise((resolve) => setTimeout(resolve, 1000));

            await closeDB();
            await appServer.stop();

            Logger.success('Graceful shutdown completed');
            process.exit(0);
        } catch (error) {
            Logger.error(`Error during shutdown: ${error}`);
            process.exit(1);
        }
    };

    process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
        Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    });

    process.on('uncaughtException', (error: Error) => {
        Logger.error(`Uncaught Exception: ${error.message}`);
        gracefulShutdown('uncaughtException').catch(() => {
            process.exit(1);
        });
    });

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    try {
        await connectDB();
        Logger.startup(ENV.USER_ADDRESSES, ENV.TRACK_ONLY_MODE ? '' : ENV.PROXY_WALLET);

        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);
        setHealthSnapshot(healthResult);
        publishAppState('health');

        if (!healthResult.healthy) {
            Logger.warning('Health check failed, but continuing startup...');
        }

        Logger.separator();

        if (!ENV.TRACK_ONLY_MODE) {
            Logger.info('Initializing CLOB client...');
            const clobClient = await createClobClient();
            Logger.success('CLOB client ready');
            Logger.info('Starting trade executor...');
            void tradeExecutor(clobClient);
        } else {
            Logger.info('Track-only mode: trade executor disabled');
        }

        Logger.info('Starting trade monitor...');
        await tradeMonitor();
    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

main();
