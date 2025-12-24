/**
 * Paper Trading Bot - Main Entry Point
 *
 * Two operating modes:
 * 1. WATCH MODE - Monitor a target wallet's trading activity
 * 2. PAPER MODE - Execute dual-side accumulation strategy with paper trades
 *                 on the SAME markets as the target wallet
 */

// CRITICAL: Initialize runId FIRST before any logger imports
// This ensures all CSV files use the same run ID
import { getRunId } from '../utils/runId';
getRunId(); // Initialize runId immediately

import chalk from 'chalk';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import {
    BinaryMarket,
    PaperTrade,
    ResolvedMarket,
    PaperTradingStats,
    PaperMarketPosition,
} from './interfaces';
import { DualSideStrategyConfig, PAPER_CONFIG, parseConfig } from './config';
import { PositionTracker } from './positionTracker';
import { TradeExecutor } from './tradeExecutor';
import { MarketDataFetcher } from './marketDataFetcher';
import { analyzePhase } from './sizingCurve';
import fetchData from '../utils/fetchData';
import { ENV } from '../config/env';
// Now import loggers (they will use the runId that was just initialized)
import marketTracker from '../services/marketTracker';
import tradeLogger from '../services/tradeLogger';
import priceStreamLogger from '../services/priceStreamLogger';

// Force initialization of paper trading CSV files on import
// This ensures they exist when the bot starts
function initializePaperTradingCsvFiles(): void {
    const runId = getRunId();
    const logsDir = path.join(process.cwd(), 'logs');
    const paperDir = path.join(logsDir, 'paper');

    // Create directories
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
    if (!fs.existsSync(paperDir)) {
        fs.mkdirSync(paperDir, { recursive: true });
    }

    // Paper trades CSV
    const paperTradesPath = path.join(paperDir, `Paper Trades_${runId}.csv`);
    if (!fs.existsSync(paperTradesPath)) {
        const tradesHeaders = [
            'Timestamp',
            'Date',
            'Year',
            'Month',
            'Day',
            'Hour',
            'Minute',
            'Second',
            'Millisecond',
            'Trader Address',
            'Trader Name',
            'Transaction Hash',
            'Condition ID',
            'Market Name',
            'Market Slug',
            'Market Key',
            'Side',
            'Outcome',
            'Outcome Index',
            'Asset',
            'Size (Shares)',
            'Price Per Share ($)',
            'Total Value ($)',
            'Market Price UP ($)',
            'Market Price DOWN ($)',
            'Price Difference UP',
            'Price Difference DOWN',
            'Entry Type',
            'Skew Magnitude',
            'Dominant Side',
            'Target Allocation',
            'Reason',
        ].join(',');
        fs.writeFileSync(paperTradesPath, tradesHeaders + '\n', 'utf8');
        console.log(`✓ Created CSV file: ${paperTradesPath}`);
    }

    // Paper trading PnL CSV
    const paperPnlPath = path.join(paperDir, `Paper Market PNL_${runId}.csv`);
    if (!fs.existsSync(paperPnlPath)) {
        const pnlHeaders = [
            'Timestamp',
            'Date',
            'Year',
            'Month',
            'Day',
            'Hour',
            'Minute',
            'Second',
            'Millisecond',
            'Market Key',
            'Market Name',
            'Condition ID',
            'Invested Up ($)',
            'Invested Down ($)',
            'Total Invested ($)',
            'Shares Up',
            'Shares Down',
            'Final Price Up ($)',
            'Final Price Down ($)',
            'Final Value Up ($)',
            'Final Value Down ($)',
            'Total Final Value ($)',
            'PnL Up ($)',
            'PnL Down ($)',
            'Total PnL ($)',
            'PnL Percent (%)',
            'Trades Up',
            'Trades Down',
            'Outcome',
            'Market Switch Reason',
            'Market Slug',
        ].join(',');
        fs.writeFileSync(paperPnlPath, pnlHeaders + '\n', 'utf8');
        console.log(`✓ Created CSV file: ${paperPnlPath}`);
    }
}

// Initialize CSV files immediately on module load
initializePaperTradingCsvFiles();

/**
 * Operating mode for the bot
 */
type BotMode = 'WATCH' | 'PAPER';

/**
 * Tracked market from target wallet activity
 */
interface TrackedMarketActivity {
    conditionId: string;
    slug: string;
    title: string;
    asset: string;
    outcomeIndex: number;
    outcome: string;
    currentPrice: number;
    endDate?: number;
    lastSeen: number;
}

/**
 * Paper Trading Bot class
 */
export class PaperTradingBot {
    private config: DualSideStrategyConfig;
    private positionTracker: PositionTracker;
    private tradeExecutor: TradeExecutor;
    private marketFetcher: MarketDataFetcher;

    private mode: BotMode = 'PAPER';
    private isRunning: boolean = false;
    private isPaused: boolean = false;

    private priceUpdateInterval: NodeJS.Timeout | null = null;
    private decisionInterval: NodeJS.Timeout | null = null;
    private displayInterval: NodeJS.Timeout | null = null;
    private watchInterval: NodeJS.Timeout | null = null;

    private activeMarkets: Map<string, BinaryMarket> = new Map();
    private lastDisplayTime: number = 0;

    // Track markets from target wallet
    private targetWalletMarkets: Map<string, TrackedMarketActivity> = new Map();
    private processedTradeIds: Set<string> = new Set();

    // Watch mode state
    private watchedTrades: any[] = [];

    constructor(config?: DualSideStrategyConfig) {
        this.config = config || parseConfig();
        this.positionTracker = new PositionTracker(this.config);
        this.tradeExecutor = new TradeExecutor(this.positionTracker, this.config);
        this.marketFetcher = new MarketDataFetcher(this.config);
    }

    /**
     * Show startup menu and get user selection
     */
    async showStartupMenu(): Promise<BotMode> {
        return new Promise((resolve) => {
            console.clear();
            console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
            console.log(chalk.cyan.bold('  EDGEBOT PRO - Select Operating Mode'));
            console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
            console.log('');
            console.log(chalk.white.bold('  [1] WATCH MODE'));
            console.log(chalk.gray('      Monitor target wallet trading activity'));
            console.log(chalk.gray('      - Track trades from watched addresses'));
            console.log(chalk.gray('      - Display market positions and P&L'));
            console.log(chalk.gray('      - No paper trading, observation only'));
            console.log('');
            console.log(chalk.white.bold('  [2] PAPER TRADING MODE'));
            console.log(chalk.gray('      Dual-side accumulation strategy'));
            console.log(chalk.gray('      - Trade on SAME markets as target wallet'));
            console.log(chalk.gray('      - Buy both sides with probability weighting'));
            console.log(chalk.gray('      - Paper trades with live market data'));
            console.log('');

            // Show target wallet
            const targetWallet = ENV.USER_ADDRESSES?.[0] || 'Not configured';
            console.log(chalk.yellow(`  Target Wallet: ${targetWallet}`));
            console.log('');
            console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
            console.log('');

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });

            const askQuestion = () => {
                rl.question(chalk.yellow('  Select mode (1 or 2): '), (answer) => {
                    const choice = answer.trim();
                    if (choice === '1') {
                        rl.close();
                        resolve('WATCH');
                    } else if (choice === '2') {
                        rl.close();
                        resolve('PAPER');
                    } else {
                        console.log(chalk.red('  Invalid selection. Please enter 1 or 2.'));
                        askQuestion();
                    }
                });
            };

            askQuestion();
        });
    }

    /**
     * Start the bot with menu selection
     */
    async startWithMenu(): Promise<void> {
        this.mode = await this.showStartupMenu();
        await this.start();
    }

    /**
     * Start the bot in specified mode
     */
    async start(mode?: BotMode): Promise<void> {
        if (this.isRunning) {
            console.log(chalk.yellow('Bot is already running'));
            return;
        }

        if (mode) {
            this.mode = mode;
        }

        console.clear();

        // Display CSV files info on startup
        this.displayCsvFilesInfo();

        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

        if (this.mode === 'WATCH') {
            await this.startWatchMode();
        } else {
            await this.startPaperMode();
        }
    }

    /**
     * Display CSV files info on startup
     */
    private displayCsvFilesInfo(): void {
        const runId = getRunId();
        const logsDir = path.join(process.cwd(), 'logs');
        const livePricesDir = path.join(logsDir, 'Live prices');
        const watcherDir = path.join(logsDir, 'watcher');
        const paperDir = path.join(logsDir, 'paper');

        // Ensure directories exist
        [logsDir, livePricesDir, watcherDir, paperDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });

        // CSV files organized by folder
        const csvFilesByCategory = {
            'Live prices': {
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

        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.cyan.bold('  📁 CSV LOGGING INITIALIZED'));
        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log('');
        console.log(chalk.white(`  Run ID: ${runId}`));
        console.log(chalk.white(`  Base Location: ${logsDir}`));
        console.log('');

        for (const [category, categoryData] of Object.entries(csvFilesByCategory)) {
            console.log(chalk.yellow(`  📂 ${category}/:`));
            for (const file of categoryData.files) {
                const filePath = path.join(categoryData.dir, file.name);
                const exists = fs.existsSync(filePath);
                const status = exists ? chalk.green('✓') : chalk.gray('○');
                console.log(chalk.gray(`    ${status} ${file.desc}: ${file.name}`));
            }
            console.log('');
        }

        console.log(chalk.gray('  Note: Price streams log entries when Watch/Paper mode trades'));
        console.log('');
    }

    /**
     * Start Watch Mode - Monitor target wallet
     */
    private async startWatchMode(): Promise<void> {
        console.log(chalk.cyan.bold('  WATCH MODE - Market Tracker Dashboard'));
        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log('');

        const addresses = ENV.USER_ADDRESSES;
        if (!addresses || addresses.length === 0) {
            console.log(chalk.red('  No USER_ADDRESSES configured in .env'));
            console.log(chalk.gray('  Set USER_ADDRESSES to watch a trader\'s activity'));
            return;
        }

        console.log(chalk.white('  Watching addresses:'));
        for (const addr of addresses) {
            console.log(chalk.gray(`    - ${addr}`));
        }
        console.log('');

        this.isRunning = true;

        // Fetch and display trades
        const fetchAndDisplay = async () => {
            await this.fetchTargetWalletTrades();
            // Use existing market tracker for display
            for (const activity of this.watchedTrades.slice(-50)) {
                await marketTracker.processTrade(activity).catch(() => {});
            }
            await marketTracker.displayStats();
        };

        await fetchAndDisplay();

        this.watchInterval = setInterval(async () => {
            if (this.isRunning) {
                await fetchAndDisplay();
            }
        }, 2000);

        console.log(chalk.green('  Watch mode started'));
    }

    /**
     * Fetch trades from target wallet
     */
    private async fetchTargetWalletTrades(): Promise<void> {
        try {
            for (const address of ENV.USER_ADDRESSES) {
                const activities = await fetchData(
                    `https://data-api.polymarket.com/activity?user=${address}&type=TRADE&limit=200`
                ).catch(() => []);

                if (Array.isArray(activities)) {
                    for (const activity of activities) {
                        const tradeId = activity.transactionHash || `${activity.timestamp}-${activity.asset}`;

                        if (!this.processedTradeIds.has(tradeId)) {
                            this.processedTradeIds.add(tradeId);
                            this.watchedTrades.unshift(activity);

                            // Process trade through marketTracker (same as watcher mode)
                            // This populates the dashboard with markets
                            await marketTracker.processTrade(activity).catch(() => {});
                            
                            // Also log trade if tradeLogger is available
                            try {
                                const tradeLogger = (await import('../services/tradeLogger')).default;
                                await tradeLogger.logTrade(activity, address).catch(() => {});
                            } catch (e) {
                                // tradeLogger not available, skip
                            }

                            // Track the market
                            if (activity.conditionId) {
                                this.targetWalletMarkets.set(activity.conditionId, {
                                    conditionId: activity.conditionId,
                                    slug: activity.slug || activity.eventSlug || '',
                                    title: activity.title || '',
                                    asset: activity.asset || '',
                                    outcomeIndex: activity.outcomeIndex ?? 0,
                                    outcome: activity.outcome || '',
                                    currentPrice: parseFloat(activity.price || '0.5'),
                                    endDate: activity.endDate ? activity.endDate * 1000 : undefined,
                                    lastSeen: Date.now(),
                                });
                            }
                        }
                    }

                    // Keep only last 200 trades
                    if (this.watchedTrades.length > 200) {
                        this.watchedTrades = this.watchedTrades.slice(0, 200);
                    }
                }
            }
        } catch (error) {
            // Silently handle errors
        }
    }

    /**
     * Start Paper Trading Mode - Trade on same markets as target wallet
     */
    private async startPaperMode(): Promise<void> {
        console.log(chalk.cyan.bold('  PAPER TRADING - Dual-Side Accumulation'));
        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log('');
        console.log(chalk.white(`  Starting Capital: $${this.config.startingCapital.toFixed(2)}`));
        console.log(chalk.white(`  Max Per Market:   $${this.config.safety.maxCapitalPerMarket.toFixed(2)}`));
        console.log(chalk.white(`  Target Wallet:    ${ENV.USER_ADDRESSES?.[0] || 'Not set'}`));
        console.log('');

        if (!ENV.USER_ADDRESSES || ENV.USER_ADDRESSES.length === 0) {
            console.log(chalk.red('  ERROR: No USER_ADDRESSES configured in .env'));
            console.log(chalk.gray('  Set USER_ADDRESSES to the wallet you want to follow'));
            return;
        }

        this.isRunning = true;
        this.positionTracker.start();

        // Set market tracker to PAPER mode for correct header display
        marketTracker.setDisplayMode('PAPER');

        // Initial fetch of target wallet trades to find markets
        console.log(chalk.gray('  Fetching target wallet activity...'));
        await this.fetchTargetWalletTrades();

        // Convert target wallet markets to our format
        console.log(chalk.gray('  Building market list from target wallet...'));
        await this.syncMarketsFromTargetWallet();

        console.log(chalk.green(`  Found ${this.activeMarkets.size} market(s) from target wallet`));
        console.log('');

        // Start intervals
        this.startPaperIntervals();

        console.log(chalk.green('  Paper trading started - trading on same markets as target'));
        console.log('');
    }

    /**
     * Sync markets from target wallet activity
     */
    private async syncMarketsFromTargetWallet(): Promise<void> {
        for (const [conditionId, tracked] of this.targetWalletMarkets) {
            // Skip if we already have this market
            if (this.activeMarkets.has(conditionId)) {
                continue;
            }

            // Skip old markets (more than 1 hour old and no recent activity)
            const age = Date.now() - tracked.lastSeen;
            if (age > 60 * 60 * 1000 && tracked.endDate && tracked.endDate < Date.now()) {
                continue;
            }

            // Try to fetch full market data
            const market = await this.marketFetcher.fetchMarket(conditionId).catch(() => null);

            if (market && market.active && !market.resolved) {
                this.activeMarkets.set(conditionId, market);
                console.log(chalk.green(`  [SYNCED] ${market.slug || market.title}`));
            } else {
                // Create basic market from tracked data
                const isUp = tracked.outcomeIndex === 0 ||
                    tracked.outcome?.toLowerCase().includes('up') ||
                    tracked.outcome?.toLowerCase().includes('yes');

                const basicMarket: BinaryMarket = {
                    conditionId,
                    slug: tracked.slug || conditionId.substring(0, 20),
                    title: tracked.title || 'Unknown Market',
                    tokenIdUp: isUp ? tracked.asset : '',
                    tokenIdDown: !isUp ? tracked.asset : '',
                    priceUp: isUp ? tracked.currentPrice : (1 - tracked.currentPrice),
                    priceDown: isUp ? (1 - tracked.currentPrice) : tracked.currentPrice,
                    endDate: tracked.endDate || Date.now() + (15 * 60 * 1000),
                    active: true,
                    resolved: false,
                };

                // Only add if not ended
                if (basicMarket.endDate > Date.now()) {
                    this.activeMarkets.set(conditionId, basicMarket);
                    console.log(chalk.yellow(`  [BASIC] ${basicMarket.title.substring(0, 50)}`));
                }
            }
        }
    }

    /**
     * Start all paper trading intervals
     */
    private startPaperIntervals(): void {
        // Watch target wallet for new markets
        this.watchInterval = setInterval(async () => {
            if (this.isRunning) {
                await this.fetchTargetWalletTrades();
                await this.syncMarketsFromTargetWallet();
            }
        }, 3000); // Check every 3 seconds

        // Price update interval
        this.priceUpdateInterval = setInterval(async () => {
            await this.updatePrices();
        }, this.config.priceUpdateInterval);

        // Decision interval - make paper trades
        this.decisionInterval = setInterval(async () => {
            if (!this.isPaused) {
                await this.makeDecisions();
            }
        }, this.config.decisionInterval);

        // Display interval - use a fixed interval to prevent spam
        const displayIntervalMs = this.config.displayInterval || 2000; // Default 2 seconds
        this.displayInterval = setInterval(async () => {
            await this.displayPaperDashboard();
        }, displayIntervalMs);
    }

    /**
     * Update prices for all active markets
     */
    private async updatePrices(): Promise<void> {
        try {
            const conditionIds = Array.from(this.activeMarkets.keys());
            if (conditionIds.length === 0) return;

            const updates = await this.marketFetcher.fetchPrices(conditionIds);

            if (updates.length > 0) {
                this.positionTracker.updatePrices(updates);
                for (const update of updates) {
                    const market = this.activeMarkets.get(update.conditionId);
                    if (market) {
                        market.priceUp = update.priceUp;
                        market.priceDown = update.priceDown;
                    }
                }
            }
        } catch (error) {
            // Silently handle errors
        }
    }

    /**
     * Make trading decisions for all markets
     */
    private async makeDecisions(): Promise<void> {
        for (const market of this.activeMarkets.values()) {
            try {
                // Skip resolved or ended markets
                if (market.resolved || market.endDate < Date.now()) {
                    continue;
                }

                const { decision, trade } = this.tradeExecutor.processMarket(market);

                if (trade) {
                    console.log(chalk.green(
                        `  [PAPER TRADE] ${market.slug || market.title.substring(0, 30)} | ${trade.side} | ` +
                        `${trade.shares.toFixed(2)} shares @ $${trade.pricePerShare.toFixed(4)} = $${trade.totalCost.toFixed(2)}`
                    ));
                }
            } catch (error) {
                // Silently handle errors
            }
        }

        // Clean up ended markets
        for (const [conditionId, market] of this.activeMarkets) {
            if (market.endDate < Date.now()) {
                // Resolve the market
                const winningOutcome = market.priceUp > 0.5 ? 'UP' : 'DOWN';
                const resolved = this.positionTracker.resolveMarket(conditionId, winningOutcome);

                if (resolved && resolved.totalInvested > 0) {
                    const pnlColor = resolved.realizedPnL >= 0 ? chalk.green : chalk.red;
                    const pnlSign = resolved.realizedPnL >= 0 ? '+' : '';
                    console.log(chalk.yellow(
                        `  [RESOLVED] ${market.slug || market.title.substring(0, 30)} | ` +
                        `Winner: ${winningOutcome} | ${pnlColor(`${pnlSign}$${resolved.realizedPnL.toFixed(2)}`)}`
                    ));
                }

                this.activeMarkets.delete(conditionId);
                this.tradeExecutor.clearHistory(conditionId);
            }
        }
    }

    /**
     * Stop the bot
     */
    stop(): void {
        if (!this.isRunning) {
            return;
        }

        console.log(chalk.yellow('\nStopping bot...'));

        this.isRunning = false;
        this.positionTracker.stop();

        // Clear all intervals
        if (this.priceUpdateInterval) {
            clearInterval(this.priceUpdateInterval);
            this.priceUpdateInterval = null;
        }
        if (this.decisionInterval) {
            clearInterval(this.decisionInterval);
            this.decisionInterval = null;
        }
        if (this.displayInterval) {
            clearInterval(this.displayInterval);
            this.displayInterval = null;
        }
        if (this.watchInterval) {
            clearInterval(this.watchInterval);
            this.watchInterval = null;
        }

        // Show final stats
        if (this.mode === 'PAPER') {
            this.displayFinalStats();
        }

        console.log(chalk.green('Bot stopped'));
    }

    /**
     * Pause trading
     */
    pause(): void {
        this.isPaused = true;
        this.positionTracker.pause();
        console.log(chalk.yellow('Trading paused'));
    }

    /**
     * Resume trading
     */
    resume(): void {
        this.isPaused = false;
        this.positionTracker.resume();
        console.log(chalk.green('Trading resumed'));
    }

    /**
     * Display paper trading dashboard
     * Uses the same stable display logic as watcher mode via marketTracker
     */
    private async displayPaperDashboard(): Promise<void> {
        // Use marketTracker's stable display logic - it handles all the interval checking
        // This ensures the paper mode dashboard is exactly like the watcher dashboard
        await marketTracker.displayStats();
    }

    /**
     * Display a single position
     */
    private displayPosition(pos: PaperMarketPosition): {
        totalInvested: number;
        totalCurrentValue: number;
        totalPnl: number;
        totalTrades: number;
    } {
        const market = pos.market;
        const name = market.title || market.slug || market.conditionId;

        const investedUp = pos.positionUp.totalCost;
        const investedDown = pos.positionDown.totalCost;
        const totalInvested = investedUp + investedDown;

        const sharesUp = pos.positionUp.shares;
        const sharesDown = pos.positionDown.shares;

        const avgPriceUp = sharesUp > 0 ? investedUp / sharesUp : 0;
        const avgPriceDown = sharesDown > 0 ? investedDown / sharesDown : 0;

        const priceUp = market.priceUp ?? 0;
        const priceDown = market.priceDown ?? 0;

        // Current values and PnL per side
        const currentValueUp = sharesUp * priceUp;
        const currentValueDown = sharesDown * priceDown;

        const pnlUp = currentValueUp - investedUp;
        const pnlDown = currentValueDown - investedDown;
        const totalPnl = pnlUp + pnlDown;

        const upPercent = totalInvested > 0 ? (investedUp / totalInvested) * 100 : 0;
        const downPercent = totalInvested > 0 ? (investedDown / totalInvested) * 100 : 0;

        const totalCurrentValue = currentValueUp + currentValueDown;
        const totalTrades = pos.positionUp.tradeCount + pos.positionDown.tradeCount;

        const marketKey = (market.slug || market.conditionId || '').substring(0, 40) || 'Paper-Market';
        const marketNameDisplay =
            name.length > 50 ? name.substring(0, 47) + '...' : name;

        console.log(chalk.yellow.bold(`┌─ ${marketKey}`));
        console.log(chalk.gray(`│  ${marketNameDisplay}`));

        // UP line - match watcher style
        const upLine = `│  ${chalk.green('📈 UP')}: ${sharesUp.toFixed(2)} shares | $${investedUp.toFixed(
            2
        )} @ $${avgPriceUp.toFixed(4)}`;
        if (sharesUp > 0 && priceUp > 0) {
            const pnlColor = pnlUp >= 0 ? chalk.green : chalk.red;
            const pnlSign = pnlUp >= 0 ? '+' : '';
            const pnlPercent =
                investedUp > 0 ? ((pnlUp / investedUp) * 100).toFixed(1) : '0.0';
            console.log(
                `${upLine} | Now: $${priceUp.toFixed(4)} | ${pnlColor(
                    `${pnlSign}$${pnlUp.toFixed(2)} (${pnlPercent}%)`
                )} | ${pos.positionUp.tradeCount} trades`
            );
        } else {
            console.log(`${upLine} | ${pos.positionUp.tradeCount} trades`);
        }

        // DOWN line - match watcher style
        const downLine = `│  ${chalk.red('📉 DOWN')}: ${sharesDown.toFixed(
            2
        )} shares | $${investedDown.toFixed(2)} @ $${avgPriceDown.toFixed(4)}`;
        if (sharesDown > 0 && priceDown > 0) {
            const pnlColor = pnlDown >= 0 ? chalk.green : chalk.red;
            const pnlSign = pnlDown >= 0 ? '+' : '';
            const pnlPercent =
                investedDown > 0 ? ((pnlDown / investedDown) * 100).toFixed(1) : '0.0';
            console.log(
                `${downLine} | Now: $${priceDown.toFixed(4)} | ${pnlColor(
                    `${pnlSign}$${pnlDown.toFixed(2)} (${pnlPercent}%)`
                )} | ${pos.positionDown.tradeCount} trades`
            );
        } else {
            console.log(`${downLine} | ${pos.positionDown.tradeCount} trades`);
        }

        // Summary line - compact, same as watcher
        const totalPnlColor = totalPnl >= 0 ? chalk.green : chalk.red;
        const totalPnlSign = totalPnl >= 0 ? '+' : '';
        const totalPnlPercent =
            totalInvested > 0 ? ((totalPnl / totalInvested) * 100).toFixed(1) : '0.0';

        if (totalInvested > 0) {
            console.log(
                chalk.cyan(
                    `│  💰 Invested: $${totalInvested.toFixed(
                        2
                    )} | Value: $${totalCurrentValue.toFixed(2)} | ${totalPnlColor(
                        `PnL: ${totalPnlSign}$${totalPnl.toFixed(2)} (${totalPnlPercent}%)`
                    )}`
                )
            );
        } else {
            console.log(chalk.cyan(`│  💰 Total Invested: $${totalInvested.toFixed(2)}`));
        }

        // Visual allocation bar
        const barLength = 30;
        const upBars = Math.round((upPercent / 100) * barLength);
        const downBars = barLength - upBars;
        const upBar = chalk.green('█'.repeat(upBars));
        const downBar = chalk.red('█'.repeat(downBars));
        console.log(
            chalk.gray(
                `│  [${upBar}${downBar}] ${upPercent.toFixed(1)}% UP / ${downPercent.toFixed(
                    1
                )}% DOWN`
            )
        );
        console.log(chalk.gray('└' + '─'.repeat(78)));
        console.log('');

        return {
            totalInvested,
            totalCurrentValue,
            totalPnl,
            totalTrades,
        };
    }

    /**
     * Display final stats
     */
    private displayFinalStats(): void {
        const stats = this.positionTracker.getStats();

        console.log('');
        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.cyan.bold('  FINAL SUMMARY'));
        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log('');
        console.log(chalk.white(`  Starting:   $${this.config.startingCapital.toFixed(2)}`));
        console.log(chalk.white(`  Final:      $${stats.availableCapital.toFixed(2)}`));
        console.log(chalk.white(`  Trades:     ${stats.totalTrades}`));
        console.log(chalk.white(`  Win Rate:   ${stats.winRate.toFixed(1)}%`));

        const totalPnL = stats.totalRealizedPnL + stats.totalUnrealizedPnL;
        const pnlColor = totalPnL >= 0 ? chalk.green : chalk.red;
        console.log(pnlColor.bold(`  P&L:        ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`));
        console.log('');
    }

    getStats(): PaperTradingStats {
        return this.positionTracker.getStats();
    }

    getPositions(): PaperMarketPosition[] {
        return this.positionTracker.getActivePositions();
    }

    getResolvedMarkets(): ResolvedMarket[] {
        return this.positionTracker.getResolvedMarkets();
    }

    getMode(): BotMode {
        return this.mode;
    }
}

// Export singleton
let botInstance: PaperTradingBot | null = null;

export function getPaperTradingBot(): PaperTradingBot {
    if (!botInstance) {
        botInstance = new PaperTradingBot();
    }
    return botInstance;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
    const bot = getPaperTradingBot();

    process.on('SIGINT', () => {
        console.log('\n');
        bot.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        bot.stop();
        process.exit(0);
    });

    await bot.startWithMenu();
}

if (require.main === module) {
    main().catch(console.error);
}
