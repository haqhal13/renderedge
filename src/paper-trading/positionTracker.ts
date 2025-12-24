/**
 * Paper Position Tracker
 *
 * Manages paper trading positions, tracks P&L, and handles market resolution.
 * Maintains internal state for all active and resolved markets.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    BinaryMarket,
    PaperPosition,
    PaperMarketPosition,
    PaperTrade,
    ResolvedMarket,
    PaperTradingStats,
    BotState,
    PriceUpdate,
} from './interfaces';
import { DualSideStrategyConfig, PAPER_CONFIG } from './config';
import priceStreamLogger from '../services/priceStreamLogger';
import { getRunId } from '../utils/runId';

/**
 * Helper function to break down timestamp into detailed components
 */
function getTimestampBreakdown(timestamp: number): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
} {
    const date = new Date(timestamp);
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1, // 1-12
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
        millisecond: date.getUTCMilliseconds(),
    };
}

/**
 * Extract market key from market (matches priceStreamLogger logic)
 */
function extractMarketKey(market: BinaryMarket): string {
    const slug = market.slug || '';
    const title = market.title || '';
    const searchText = `${slug} ${title}`.toLowerCase();

    if (!searchText.trim()) return 'Unknown';

    const isBTC = searchText.includes('bitcoin') || searchText.includes('btc');
    const isETH = searchText.includes('ethereum') || searchText.includes('eth');

    if (!isBTC && !isETH) {
        // Use condition ID if available for non-BTC/ETH markets
        if (market.conditionId) {
            return `CID-${market.conditionId.substring(0, 10)}`;
        }
        return 'Unknown';
    }

    // Check for 15-minute timeframe
    const has15Min = /\b15\s*min|\b15min|updown.*?15|15.*?updown/i.test(searchText);

    // Check for hourly timeframe (explicit)
    const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(searchText);

    // Check for hourly markets by pattern: "Up or Down" with single time (e.g., "6AM ET") but NO time range
    // Hourly markets: "Bitcoin Up or Down - December 24, 6AM ET" (single time, no range)
    // 15min markets: "Bitcoin Up or Down - December 24, 6:00AM-6:15AM ET" (has time range with colon)
    // Also handle slug format: "bitcoin-up-or-down-december-24-9am-et" (with hyphens)
    const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(searchText);
    // Pattern like "6AM ET" or "7PM ET" (with spaces) OR "9am-et" (with hyphens in slug)
    const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(searchText) || /\d{1,2}(?:am|pm)-et/i.test(searchText);
    const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(searchText); // Pattern like "6:00AM-6:15AM"
    const isHourlyPattern = hasUpDown && hasSingleTime && !hasTimeRange;

    const type = isBTC ? 'BTC' : 'ETH';
    // Prioritize 15min, then hourly (explicit or pattern), otherwise generic
    const timeframe = has15Min ? 'UpDown-15' : (hasHourly || isHourlyPattern) ? 'UpDown-1h' : '';

    return timeframe ? `${type}-${timeframe}` : type;
}

/**
 * Create an empty paper position
 */
function createEmptyPosition(side: 'UP' | 'DOWN'): PaperPosition {
    return {
        side,
        shares: 0,
        totalCost: 0,
        averagePrice: 0,
        tradeCount: 0,
        firstTradeTime: 0,
        lastTradeTime: 0,
    };
}

/**
 * Paper Position Tracker class
 */
export class PositionTracker {
    private state: BotState;
    private config: DualSideStrategyConfig;
    private csvFilePath: string;
    private tradesLogPath: string;

    constructor(config: DualSideStrategyConfig = PAPER_CONFIG) {
        this.config = config;
        this.state = this.initializeState();

        // Initialize logging paths in paper folder with run ID
        const logsDir = path.join(process.cwd(), 'logs');
        const paperDir = path.join(logsDir, 'paper');
        
        // Create directories
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        if (!fs.existsSync(paperDir)) {
            fs.mkdirSync(paperDir, { recursive: true });
        }
        
        const runId = getRunId();
        this.csvFilePath = path.join(paperDir, `Paper Market PNL_${runId}.csv`);
        this.tradesLogPath = path.join(paperDir, `Paper Trades_${runId}.csv`);

        this.initializeCsvFiles();
    }

    /**
     * Initialize bot state
     */
    private initializeState(): BotState {
        return {
            startingCapital: this.config.startingCapital,
            currentCapital: this.config.startingCapital,
            maxCapitalPerMarket: this.config.safety.maxCapitalPerMarket,

            positions: new Map(),
            trades: [],
            resolvedMarkets: [],

            stats: this.initializeStats(),

            lastPriceUpdate: 0,
            lastTradeCheck: 0,

            isRunning: false,
            isPaused: false,
        };
    }

    /**
     * Initialize stats
     */
    private initializeStats(): PaperTradingStats {
        return {
            totalMarketsTraded: 0,
            activeMarkets: 0,
            resolvedMarkets: 0,

            totalCapitalDeployed: 0,
            currentCapitalInMarkets: 0,
            availableCapital: this.config.startingCapital,

            totalRealizedPnL: 0,
            totalUnrealizedPnL: 0,
            winRate: 0,

            totalTrades: 0,
            tradesUp: 0,
            tradesDown: 0,

            startTime: Date.now(),
            lastTradeTime: 0,

            avgInvestmentPerMarket: 0,
            avgPnLPerMarket: 0,
            avgTradesPerMarket: 0,
        };
    }

    /**
     * Initialize CSV files with headers
     */
    private initializeCsvFiles(): void {
        try {
            // P&L CSV - always create new file for each run
            // Format matches watcher_market_pnl CSV for easy comparison
            const headers = [
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
                    // Paper-specific column
                    'Market Slug',
                ].join(',');
            fs.writeFileSync(this.csvFilePath, headers + '\n', 'utf8');
            console.log(`✓ Created CSV file: ${this.csvFilePath}`);

            // Trades log CSV - always create new file for each run
            // Format matches watcher_trades CSV for easy comparison
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
                    'Trader Address',      // N/A for paper trades (paper mode)
                    'Trader Name',         // N/A for paper trades (paper mode)
                    'Transaction Hash',    // N/A for paper trades (paper mode)
                    'Condition ID',
                    'Market Name',
                    'Market Slug',
                    'Market Key',
                    'Side',
                    'Outcome',
                    'Outcome Index',
                    'Asset',               // N/A for paper trades
                    'Size (Shares)',
                    'Price Per Share ($)',
                    'Total Value ($)',
                    'Market Price UP ($)',
                    'Market Price DOWN ($)',
                    'Price Difference UP',
                    'Price Difference DOWN',
                    'Entry Type',
                    // Paper-specific columns (extra info)
                    'Skew Magnitude',
                    'Dominant Side',
                    'Target Allocation',
                    'Reason',
                ].join(',');
            fs.writeFileSync(this.tradesLogPath, tradesHeaders + '\n', 'utf8');
            console.log(`✓ Created CSV file: ${this.tradesLogPath}`);
        } catch (error) {
            console.error(`✗ Failed to create paper trading CSV files:`, error);
        }
    }

    /**
     * Get or create a market position
     */
    getOrCreatePosition(market: BinaryMarket): PaperMarketPosition {
        let position = this.state.positions.get(market.conditionId);

        if (!position) {
            position = {
                market,
                positionUp: createEmptyPosition('UP'),
                positionDown: createEmptyPosition('DOWN'),
                currentAllocationUp: 0.5,
                currentAllocationDown: 0.5,
                targetAllocationUp: 0.5,
                targetAllocationDown: 0.5,
                firstTradeTime: 0,
                lastTradeTime: 0,
                totalInvested: 0,
                currentValue: 0,
                unrealizedPnL: 0,
                unrealizedPnLPercent: 0,
            };
            this.state.positions.set(market.conditionId, position);
            this.state.stats.totalMarketsTraded++;
            this.state.stats.activeMarkets++;
        }

        return position;
    }

    /**
     * Record a paper trade
     */
    recordTrade(trade: PaperTrade): void {
        const position = this.state.positions.get(trade.conditionId);
        if (!position) {
            console.error(`No position found for trade: ${trade.conditionId}`);
            return;
        }

        // Update the appropriate side
        const sidePosition = trade.side === 'UP' ? position.positionUp : position.positionDown;

        // Update position
        const prevShares = sidePosition.shares;
        const prevCost = sidePosition.totalCost;

        sidePosition.shares += trade.shares;
        sidePosition.totalCost += trade.totalCost;
        sidePosition.averagePrice = sidePosition.totalCost / sidePosition.shares;
        sidePosition.tradeCount++;

        if (sidePosition.firstTradeTime === 0) {
            sidePosition.firstTradeTime = trade.timestamp;
        }
        sidePosition.lastTradeTime = trade.timestamp;

        // Update market position
        position.totalInvested = position.positionUp.totalCost + position.positionDown.totalCost;
        position.lastTradeTime = trade.timestamp;

        if (position.firstTradeTime === 0) {
            position.firstTradeTime = trade.timestamp;
        }

        // Update allocations
        if (position.totalInvested > 0) {
            position.currentAllocationUp = position.positionUp.totalCost / position.totalInvested;
            position.currentAllocationDown = position.positionDown.totalCost / position.totalInvested;
        }

        // Update state
        this.state.currentCapital -= trade.totalCost;
        this.state.trades.push(trade);
        this.state.stats.totalTrades++;
        this.state.stats.lastTradeTime = trade.timestamp;

        if (trade.side === 'UP') {
            this.state.stats.tradesUp++;
        } else {
            this.state.stats.tradesDown++;
        }

        // Log trade if configured
        if (this.config.logTrades) {
            this.logTrade(trade);
        }

        // Update stats
        this.updateStats();
    }

    /**
     * Log trade to CSV
     * Format matches watcher_trades CSV for easy comparison
     */
    private logTrade(trade: PaperTrade): void {
        if (!this.config.csvLogging) return;

        const timeBreakdown = getTimestampBreakdown(trade.timestamp);
        const position = this.state.positions.get(trade.conditionId);
        const market = position?.market;
        const marketKey = market ? extractMarketKey(market) : 'Unknown';
        const outcome = trade.side;
        const outcomeIndex = trade.side === 'UP' ? 0 : 1;

        // Get market prices at time of trade
        const priceUp = market?.priceUp ?? 0.5;
        const priceDown = market?.priceDown ?? 0.5;

        // Calculate price differences
        const priceDifferenceUp = trade.side === 'UP' ? (trade.pricePerShare - priceUp) : 0;
        const priceDifferenceDown = trade.side === 'DOWN' ? (trade.pricePerShare - priceDown) : 0;

        // Row format matches watcher_trades CSV headers
        const row = [
            trade.timestamp,
            new Date(trade.timestamp).toISOString(),
            timeBreakdown.year,
            timeBreakdown.month,
            timeBreakdown.day,
            timeBreakdown.hour,
            timeBreakdown.minute,
            timeBreakdown.second,
            timeBreakdown.millisecond,
            'PAPER_BOT',                              // Trader Address (N/A for paper)
            'Paper Trading Bot',                      // Trader Name (N/A for paper)
            '',                                       // Transaction Hash (N/A for paper)
            trade.conditionId,
            `"${trade.marketTitle.replace(/"/g, '""')}"`,
            trade.marketSlug,
            marketKey,
            trade.side,
            outcome,
            outcomeIndex,
            '',                                       // Asset (N/A for paper)
            trade.shares.toFixed(4),
            trade.pricePerShare.toFixed(4),
            trade.totalCost.toFixed(2),
            priceUp.toFixed(4),
            priceDown.toFixed(4),
            priceDifferenceUp.toFixed(4),
            priceDifferenceDown.toFixed(4),
            'PAPER',                                  // Entry Type
            // Paper-specific columns
            trade.skewAtTrade.skewMagnitude.toFixed(4),
            trade.skewAtTrade.dominantSide,
            `${(trade.allocationAtTrade.dominantSideRatio * 100).toFixed(0)}/${(trade.allocationAtTrade.minoritySideRatio * 100).toFixed(0)}`,
            `"${trade.reason.replace(/"/g, '""')}"`,
        ].join(',');

        try {
            fs.appendFileSync(this.tradesLogPath, row + '\n', 'utf8');
            
            // Log to price stream with paper mode entry marker
            priceStreamLogger.markPaperEntry(
                trade.marketSlug,
                trade.marketTitle,
                priceUp,
                priceDown,
                `Paper mode trade: ${trade.side} ${trade.shares.toFixed(4)} shares @ $${trade.pricePerShare.toFixed(4)}`
            );
        } catch (error) {
            console.error('Failed to log trade:', error);
        }
    }

    /**
     * Update prices for all positions
     */
    updatePrices(updates: PriceUpdate[]): void {
        for (const update of updates) {
            const position = this.state.positions.get(update.conditionId);
            if (position) {
                position.market.priceUp = update.priceUp;
                position.market.priceDown = update.priceDown;

                // Recalculate current value
                const valueUp = position.positionUp.shares * update.priceUp;
                const valueDown = position.positionDown.shares * update.priceDown;
                position.currentValue = valueUp + valueDown;

                // Calculate unrealized P&L
                position.unrealizedPnL = position.currentValue - position.totalInvested;
                position.unrealizedPnLPercent = position.totalInvested > 0
                    ? (position.unrealizedPnL / position.totalInvested) * 100
                    : 0;

                // Log price to price stream (periodic updates)
                priceStreamLogger.logPrice(
                    position.market.slug,
                    position.market.title,
                    update.priceUp,
                    update.priceDown
                );
            }
        }

        this.state.lastPriceUpdate = Date.now();
        this.updateStats();
    }

    /**
     * Resolve a market and calculate final P&L
     */
    resolveMarket(conditionId: string, winningOutcome: 'UP' | 'DOWN'): ResolvedMarket | null {
        const position = this.state.positions.get(conditionId);
        if (!position) {
            console.error(`No position found for resolution: ${conditionId}`);
            return null;
        }

        // Update market state
        position.market.resolved = true;
        position.market.resolutionOutcome = winningOutcome;
        position.market.active = false;

        // Calculate payout
        // Winning side pays $1 per share, losing side pays $0
        const winningSidePosition = winningOutcome === 'UP' ? position.positionUp : position.positionDown;
        const losingSidePosition = winningOutcome === 'UP' ? position.positionDown : position.positionUp;

        const payout = winningSidePosition.shares * 1.0; // $1 per winning share

        // Calculate P&L
        const totalInvested = position.totalInvested;
        const realizedPnL = payout - totalInvested;
        const realizedPnLPercent = totalInvested > 0
            ? (realizedPnL / totalInvested) * 100
            : 0;

        // Create resolved market record
        const resolved: ResolvedMarket = {
            market: position.market,
            position,
            resolutionTime: Date.now(),
            winningOutcome,
            investedUp: position.positionUp.totalCost,
            investedDown: position.positionDown.totalCost,
            totalInvested,
            sharesUp: position.positionUp.shares,
            sharesDown: position.positionDown.shares,
            payout,
            realizedPnL,
            realizedPnLPercent,
            winningSideSharesHeld: winningSidePosition.shares,
            losingSideSharesHeld: losingSidePosition.shares,
            winningSideInvested: winningSidePosition.totalCost,
            losingSideInvested: losingSidePosition.totalCost,
        };

        // Update state
        this.state.resolvedMarkets.push(resolved);
        this.state.positions.delete(conditionId);
        this.state.currentCapital += payout;
        this.state.stats.totalRealizedPnL += realizedPnL;
        this.state.stats.resolvedMarkets++;
        this.state.stats.activeMarkets--;

        // Log to CSV
        this.logResolvedMarket(resolved);

        // Update stats
        this.updateStats();

        return resolved;
    }

    /**
     * Log resolved market to CSV
     * Format matches watcher_market_pnl CSV for easy comparison
     */
    private logResolvedMarket(resolved: ResolvedMarket): void {
        if (!this.config.csvLogging) return;

        const timeBreakdown = getTimestampBreakdown(resolved.resolutionTime);
        const marketKey = extractMarketKey(resolved.market);
        const finalPriceUp = resolved.winningOutcome === 'UP' ? 1.00 : 0.00;
        const finalPriceDown = resolved.winningOutcome === 'DOWN' ? 1.00 : 0.00;
        const finalValueUp = resolved.sharesUp * finalPriceUp;
        const finalValueDown = resolved.sharesDown * finalPriceDown;
        const totalFinalValue = finalValueUp + finalValueDown;
        const pnlUp = finalValueUp - resolved.investedUp;
        const pnlDown = finalValueDown - resolved.investedDown;

        // Row format matches watcher_market_pnl CSV headers
        const row = [
            resolved.resolutionTime,
            new Date(resolved.resolutionTime).toISOString(),
            timeBreakdown.year,
            timeBreakdown.month,
            timeBreakdown.day,
            timeBreakdown.hour,
            timeBreakdown.minute,
            timeBreakdown.second,
            timeBreakdown.millisecond,
            marketKey,
            `"${resolved.market.title.replace(/"/g, '""')}"`,
            resolved.market.conditionId,
            resolved.investedUp.toFixed(2),
            resolved.investedDown.toFixed(2),
            resolved.totalInvested.toFixed(2),
            resolved.sharesUp.toFixed(4),
            resolved.sharesDown.toFixed(4),
            finalPriceUp.toFixed(4),
            finalPriceDown.toFixed(4),
            finalValueUp.toFixed(2),
            finalValueDown.toFixed(2),
            totalFinalValue.toFixed(2),
            pnlUp.toFixed(2),
            pnlDown.toFixed(2),
            resolved.realizedPnL.toFixed(2),
            resolved.realizedPnLPercent.toFixed(2),
            resolved.position.positionUp.tradeCount,
            resolved.position.positionDown.tradeCount,
            `${resolved.winningOutcome} Won`,  // Outcome format matches watcher (e.g., "UP Won")
            'Market Resolved',                  // Market Switch Reason
            // Paper-specific column
            resolved.market.slug,               // Market Slug
        ].join(',');

        try {
            fs.appendFileSync(this.csvFilePath, row + '\n', 'utf8');
        } catch (error) {
            console.error('Failed to log resolved market:', error);
        }
    }

    /**
     * Update aggregate statistics
     */
    private updateStats(): void {
        const stats = this.state.stats;

        // Capital calculations
        let currentCapitalInMarkets = 0;
        let totalUnrealizedPnL = 0;

        for (const position of this.state.positions.values()) {
            currentCapitalInMarkets += position.totalInvested;
            totalUnrealizedPnL += position.unrealizedPnL;
        }

        stats.currentCapitalInMarkets = currentCapitalInMarkets;
        stats.totalUnrealizedPnL = totalUnrealizedPnL;
        stats.availableCapital = this.state.currentCapital;
        stats.totalCapitalDeployed = this.config.startingCapital - this.state.currentCapital + currentCapitalInMarkets;

        // Win rate
        if (this.state.resolvedMarkets.length > 0) {
            const wins = this.state.resolvedMarkets.filter(r => r.realizedPnL > 0).length;
            stats.winRate = (wins / this.state.resolvedMarkets.length) * 100;
        }

        // Averages
        if (stats.totalMarketsTraded > 0) {
            stats.avgInvestmentPerMarket = stats.totalCapitalDeployed / stats.totalMarketsTraded;
            stats.avgTradesPerMarket = stats.totalTrades / stats.totalMarketsTraded;
        }

        if (stats.resolvedMarkets > 0) {
            stats.avgPnLPerMarket = stats.totalRealizedPnL / stats.resolvedMarkets;
        }
    }

    /**
     * Check if we can trade in a market (capital limits)
     */
    canTradeInMarket(conditionId: string, amount: number): { canTrade: boolean; reason: string } {
        // Check available capital
        if (amount > this.state.currentCapital) {
            return {
                canTrade: false,
                reason: `Insufficient capital: need $${amount.toFixed(2)}, have $${this.state.currentCapital.toFixed(2)}`,
            };
        }

        // Check per-market limit
        const position = this.state.positions.get(conditionId);
        if (position) {
            const newTotal = position.totalInvested + amount;
            if (newTotal > this.config.safety.maxCapitalPerMarket) {
                return {
                    canTrade: false,
                    reason: `Market cap exceeded: $${newTotal.toFixed(2)} > $${this.config.safety.maxCapitalPerMarket}`,
                };
            }
        }

        // Check max active markets
        if (!position && this.state.positions.size >= this.config.safety.maxActiveMarkets) {
            return {
                canTrade: false,
                reason: `Max markets reached: ${this.state.positions.size}/${this.config.safety.maxActiveMarkets}`,
            };
        }

        // Check max capital deployed percentage
        const currentDeployed = this.config.startingCapital - this.state.currentCapital;
        const newDeployed = currentDeployed + amount;
        const newDeployedPercent = newDeployed / this.config.startingCapital;

        if (newDeployedPercent > this.config.safety.maxCapitalDeployedPercent) {
            return {
                canTrade: false,
                reason: `Max deployment exceeded: ${(newDeployedPercent * 100).toFixed(1)}% > ${(this.config.safety.maxCapitalDeployedPercent * 100)}%`,
            };
        }

        return { canTrade: true, reason: '' };
    }

    /**
     * Get current state
     */
    getState(): BotState {
        return this.state;
    }

    /**
     * Get all active positions
     */
    getActivePositions(): PaperMarketPosition[] {
        return Array.from(this.state.positions.values());
    }

    /**
     * Get position for a specific market
     */
    getPosition(conditionId: string): PaperMarketPosition | undefined {
        return this.state.positions.get(conditionId);
    }

    /**
     * Get current stats
     */
    getStats(): PaperTradingStats {
        return this.state.stats;
    }

    /**
     * Get all trades
     */
    getTrades(): PaperTrade[] {
        return this.state.trades;
    }

    /**
     * Get resolved markets
     */
    getResolvedMarkets(): ResolvedMarket[] {
        return this.state.resolvedMarkets;
    }

    /**
     * Get available capital
     */
    getAvailableCapital(): number {
        return this.state.currentCapital;
    }

    /**
     * Start the tracker
     */
    start(): void {
        this.state.isRunning = true;
        this.state.isPaused = false;
    }

    /**
     * Pause the tracker
     */
    pause(): void {
        this.state.isPaused = true;
    }

    /**
     * Resume the tracker
     */
    resume(): void {
        this.state.isPaused = false;
    }

    /**
     * Stop the tracker
     */
    stop(): void {
        this.state.isRunning = false;
    }

    /**
     * Check if running
     */
    isRunning(): boolean {
        return this.state.isRunning && !this.state.isPaused;
    }

    /**
     * Reset state (for testing)
     */
    reset(): void {
        this.state = this.initializeState();
    }

    /**
     * Export state to JSON (for persistence)
     */
    exportState(): string {
        const exportable = {
            ...this.state,
            positions: Array.from(this.state.positions.entries()),
        };
        return JSON.stringify(exportable, null, 2);
    }

    /**
     * Import state from JSON (for persistence)
     */
    importState(json: string): void {
        const imported = JSON.parse(json);
        this.state = {
            ...imported,
            positions: new Map(imported.positions),
        };
    }
}

// Export singleton instance
export const positionTracker = new PositionTracker();
