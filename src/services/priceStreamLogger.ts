/**
 * Price Stream Logger
 *
 * Logs real-time orderbook prices with millisecond precision
 * Inserts watcher/paper trades at their exact timestamps with matching prices
 */

import * as fs from 'fs';
import * as path from 'path';
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
 * Extract market key from market slug/title
 */
function extractMarketKey(slug: string, title: string): { type: 'BTC' | 'ETH' | null; timeframe: '15m' | '1h' | null } {
    const searchText = `${slug} ${title}`.toLowerCase();

    const isBTC = searchText.includes('bitcoin') || searchText.includes('btc');
    const isETH = searchText.includes('ethereum') || searchText.includes('eth');

    if (!isBTC && !isETH) {
        return { type: null, timeframe: null };
    }

    // Check for 15-minute timeframe - explicit text
    const hasExplicit15Min = /\b15\s*min|\b15min|updown.*?15|15.*?updown/i.test(searchText);

    // Check for 15-minute timeframe - time range pattern like "6:00AM-6:15AM"
    const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(searchText);

    // 15min markets have either explicit "15min" OR a time range with colons
    const is15Min = hasExplicit15Min || hasTimeRange;

    // Check for hourly timeframe (explicit)
    const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(searchText);

    // Check for hourly markets by pattern
    const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(searchText);
    const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(searchText) || /\d{1,2}(?:am|pm)-et/i.test(searchText);
    const isHourlyPattern = hasUpDown && hasSingleTime && !hasTimeRange;

    const type = isBTC ? 'BTC' : 'ETH';
    const timeframe = is15Min ? '15m' : (hasHourly || isHourlyPattern) ? '1h' : null;

    return { type, timeframe };
}

class PriceStreamLogger {
    private btc15mPath: string;
    private eth15mPath: string;
    private btc1hPath: string;
    private eth1hPath: string;
    // Track logged trades to prevent duplicates
    private loggedTradeEntries: Set<string> = new Set();
    // Track last logged timestamp per market (to avoid duplicate rows at same ms)
    private lastLoggedTimestamp: Map<string, number> = new Map();
    // Track current market window start times - only log when we've seen a new market
    // Key: "BTC-15m", "ETH-15m", "BTC-1h", "ETH-1h"
    // Value: Unix timestamp (seconds) of the current market window start
    private currentMarketWindow: Map<string, number> = new Map();
    // Track if logging is enabled for each market (enabled when new market window starts)
    private loggingEnabled: Map<string, boolean> = new Map();

    constructor() {
        const logsDir = path.join(process.cwd(), 'logs');
        const livePricesDir = path.join(logsDir, 'Live prices');

        // Create directories
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        if (!fs.existsSync(livePricesDir)) {
            fs.mkdirSync(livePricesDir, { recursive: true });
        }

        const runId = getRunId();
        this.btc15mPath = this.findOrCreatePriceFile(livePricesDir, 'BTC', '15 min', runId);
        this.eth15mPath = this.findOrCreatePriceFile(livePricesDir, 'ETH', '15 min', runId);
        this.btc1hPath = this.findOrCreatePriceFile(livePricesDir, 'BTC', '1 hour', runId);
        this.eth1hPath = this.findOrCreatePriceFile(livePricesDir, 'ETH', '1 hour', runId);

        this.initializeCsvFiles();
    }

    private findOrCreatePriceFile(livePricesDir: string, asset: string, timeframe: string, currentRunId: string): string {
        try {
            const escapedTimeframe = timeframe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
            const pattern = new RegExp(`^${asset} - ${escapedTimeframe} prices_\\d{8}-\\d{6}\\.csv$`);

            const files = fs.readdirSync(livePricesDir)
                .filter(file => pattern.test(file))
                .map(file => ({
                    name: file,
                    path: path.join(livePricesDir, file),
                    stats: fs.statSync(path.join(livePricesDir, file))
                }))
                .sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());

            if (files.length > 0) {
                console.log(`✓ Reusing existing CSV file: ${files[0].name}`);
                return files[0].path;
            }
        } catch (error) {
            // Fall through to create new file
        }

        return path.join(livePricesDir, `${asset} - ${timeframe} prices_${currentRunId}.csv`);
    }

    private initializeCsvFiles(): void {
        try {
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
                'Price UP ($)',
                'Price DOWN ($)',
                'Watch Mode Entry',
                'Paper Mode Entry',
                'Notes'
            ].join(',');

            const files = [
                { path: this.btc15mPath, name: 'BTC 15 min' },
                { path: this.eth15mPath, name: 'ETH 15 min' },
                { path: this.btc1hPath, name: 'BTC 1 hour' },
                { path: this.eth1hPath, name: 'ETH 1 hour' }
            ];

            for (const file of files) {
                if (!fs.existsSync(file.path)) {
                    fs.writeFileSync(file.path, headers + '\n', 'utf8');
                    console.log(`✓ Created CSV file: ${file.path}`);
                } else {
                    console.log(`✓ Using existing CSV file: ${file.path}`);
                }
            }
        } catch (error) {
            console.error(`✗ Failed to initialize price CSV files:`, error);
        }
    }

    /**
     * Get the file path for a market
     */
    private getFilePath(type: 'BTC' | 'ETH', timeframe: '15m' | '1h'): string {
        if (type === 'BTC' && timeframe === '15m') return this.btc15mPath;
        if (type === 'ETH' && timeframe === '15m') return this.eth15mPath;
        if (type === 'BTC' && timeframe === '1h') return this.btc1hPath;
        return this.eth1hPath;
    }

    /**
     * Write a single row to CSV
     */
    private writeRow(
        filePath: string,
        timestamp: number,
        priceUp: number,
        priceDown: number,
        isWatch: boolean,
        isPaper: boolean,
        notes?: string
    ): void {
        try {
            const timeBreakdown = getTimestampBreakdown(timestamp);
            const date = new Date(timestamp).toISOString();

            const notesField = notes ? `"${notes.replace(/"/g, '""')}"` : '';

            const row = [
                timestamp,
                date,
                timeBreakdown.year,
                timeBreakdown.month,
                timeBreakdown.day,
                timeBreakdown.hour,
                timeBreakdown.minute,
                timeBreakdown.second,
                timeBreakdown.millisecond,
                priceUp.toFixed(4),
                priceDown.toFixed(4),
                isWatch ? 'YES' : '',
                isPaper ? 'YES' : '',
                notesField,
            ].join(',');

            fs.appendFileSync(filePath, row + '\n', 'utf8');
        } catch (error) {
            console.error(`Failed to write row to ${filePath}:`, error);
        }
    }

    /**
     * Notify that a new market window has started
     * This enables logging for that market and clears old data tracking
     * @param type - 'BTC' or 'ETH'
     * @param timeframe - '15m' or '1h'
     * @param windowStartTimestamp - Unix timestamp (seconds) of the market window start
     */
    notifyNewMarketWindow(type: 'BTC' | 'ETH', timeframe: '15m' | '1h', windowStartTimestamp: number): void {
        const marketKey = `${type}-${timeframe}`;
        const currentWindow = this.currentMarketWindow.get(marketKey);

        // Only update if this is a NEW window (different timestamp)
        if (currentWindow !== windowStartTimestamp) {
            this.currentMarketWindow.set(marketKey, windowStartTimestamp);
            this.loggingEnabled.set(marketKey, true);

            // Clear old logged entries for this market to allow fresh logging
            const prefix = `${type}-${timeframe}`;
            for (const key of this.loggedTradeEntries) {
                if (key.includes(prefix)) {
                    this.loggedTradeEntries.delete(key);
                }
            }

            console.log(`📊 Price logging enabled for ${marketKey} (window: ${new Date(windowStartTimestamp * 1000).toISOString()})`);
        }
    }

    /**
     * Check if logging is enabled for a market
     */
    isLoggingEnabled(type: 'BTC' | 'ETH', timeframe: '15m' | '1h'): boolean {
        const marketKey = `${type}-${timeframe}`;
        return this.loggingEnabled.get(marketKey) || false;
    }

    /**
     * Log price update - writes immediately with current timestamp
     * Called frequently to capture real-time price movements
     * Only logs if a new market window has been notified
     */
    logPrice(marketSlug: string, marketTitle: string, priceUp: number, priceDown: number): void {
        const { type, timeframe } = extractMarketKey(marketSlug, marketTitle);
        if (!type || !timeframe) return;

        const marketKey = `${type}-${timeframe}`;

        // Only log if logging is enabled for this market (new window has started)
        if (!this.loggingEnabled.get(marketKey)) {
            return;
        }

        const timestamp = Date.now();
        const filePath = this.getFilePath(type, timeframe);

        // Only write if timestamp is different from last (avoid duplicate ms rows)
        const lastTs = this.lastLoggedTimestamp.get(marketKey) || 0;
        if (timestamp <= lastTs) return;

        this.lastLoggedTimestamp.set(marketKey, timestamp);
        this.writeRow(filePath, timestamp, priceUp, priceDown, false, false);
    }

    /**
     * Mark a watcher trade entry
     * Uses the EXACT timestamp from the trade and the execution price
     *
     * @param marketSlug - Market slug
     * @param marketTitle - Market title
     * @param priceUp - The execution price for UP (what watcher paid)
     * @param priceDown - The execution price for DOWN (derived: 1 - priceUp)
     * @param notes - Trade details (e.g., "UP 10.0000 shares @ $0.0200")
     * @param transactionHash - Unique trade identifier
     * @param tradeTimestamp - EXACT timestamp from the trade (in ms)
     */
    markWatchEntry(
        marketSlug: string,
        marketTitle: string,
        priceUp: number,
        priceDown: number,
        notes?: string,
        transactionHash?: string,
        tradeTimestamp?: number
    ): void {
        const { type, timeframe } = extractMarketKey(marketSlug, marketTitle);
        if (!type || !timeframe) return;

        const marketKey = `${type}-${timeframe}`;

        // Only log if logging is enabled for this market (new window has started)
        if (!this.loggingEnabled.get(marketKey)) {
            return;
        }

        // Prevent duplicate entries
        const tradeKey = transactionHash
            ? `WATCH:${transactionHash}`
            : `WATCH:${type}-${timeframe}:${notes}`;

        if (this.loggedTradeEntries.has(tradeKey)) return;
        this.loggedTradeEntries.add(tradeKey);

        const filePath = this.getFilePath(type, timeframe);

        // Use the exact trade timestamp if provided, otherwise use now
        const timestamp = tradeTimestamp || Date.now();

        this.writeRow(
            filePath,
            timestamp,
            priceUp,
            priceDown,
            true,  // isWatch
            false, // isPaper
            `WATCH: ${notes}`
        );
    }

    /**
     * Mark a paper trade entry
     */
    markPaperEntry(
        marketSlug: string,
        marketTitle: string,
        priceUp: number,
        priceDown: number,
        notes?: string,
        transactionHash?: string,
        tradeTimestamp?: number
    ): void {
        const { type, timeframe } = extractMarketKey(marketSlug, marketTitle);
        if (!type || !timeframe) return;

        const marketKey = `${type}-${timeframe}`;

        // Only log if logging is enabled for this market (new window has started)
        if (!this.loggingEnabled.get(marketKey)) {
            return;
        }

        const tradeKey = transactionHash
            ? `PAPER:${transactionHash}`
            : `PAPER:${type}-${timeframe}:${notes}`;

        if (this.loggedTradeEntries.has(tradeKey)) return;
        this.loggedTradeEntries.add(tradeKey);

        const filePath = this.getFilePath(type, timeframe);
        const timestamp = tradeTimestamp || Date.now();

        this.writeRow(
            filePath,
            timestamp,
            priceUp,
            priceDown,
            false, // isWatch
            true,  // isPaper
            `PAPER: ${notes}`
        );
    }

    /**
     * Get current prices (for compatibility)
     */
    getCurrentPrices(marketSlug: string, marketTitle: string): { priceUp: number; priceDown: number } | null {
        return null; // Not tracking state anymore - prices come from orderbook
    }
}

export default new PriceStreamLogger();
