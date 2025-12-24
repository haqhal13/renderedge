/**
 * Price Stream Logger
 * 
 * Logs BTC and ETH prices at 15-minute and 1-hour intervals
 * Marks when watch mode and paper mode enter trades
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
    // This identifies 15min markets by the colon format in times (e.g., 6:00AM, 10:30PM)
    const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(searchText);

    // 15min markets have either explicit "15min" OR a time range with colons
    const is15Min = hasExplicit15Min || hasTimeRange;

    // Check for hourly timeframe (explicit)
    const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(searchText);

    // Check for hourly markets by pattern: "Up or Down" with single time (e.g., "6AM ET") but NO time range
    // Hourly markets: "Bitcoin Up or Down - December 24, 6AM ET" (single time, no range)
    // 15min markets: "Bitcoin Up or Down - December 24, 6:00AM-6:15AM ET" (has time range with colon)
    // Also handle slug format: "bitcoin-up-or-down-december-24-9am-et" (with hyphens)
    const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(searchText);
    // Pattern like "6AM ET" or "7PM ET" (with spaces) OR "9am-et" (with hyphens in slug)
    const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(searchText) || /\d{1,2}(?:am|pm)-et/i.test(searchText);
    const isHourlyPattern = hasUpDown && hasSingleTime && !hasTimeRange;

    const type = isBTC ? 'BTC' : 'ETH';
    // Prioritize 15min (explicit or time range), then hourly (explicit or pattern), otherwise null
    const timeframe = is15Min ? '15m' : (hasHourly || isHourlyPattern) ? '1h' : null;

    return { type, timeframe };
}

/**
 * Pending entry info for aggregating trades within an interval
 */
interface PendingEntry {
    priceUp: number;
    priceDown: number;
    watchTrades: string[];
    paperTrades: string[];
    lastUpdate: number;
}

class PriceStreamLogger {
    private btc15mPath: string;
    private eth15mPath: string;
    private btc1hPath: string;
    private eth1hPath: string;
    private lastLogged15m: Map<string, number> = new Map(); // Track last 15m log time per market
    private lastLogged1h: Map<string, number> = new Map(); // Track last 1h log time per market
    // Track pending entries to aggregate trades within same interval
    private pendingEntries: Map<string, PendingEntry> = new Map();

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
        this.btc15mPath = path.join(livePricesDir, `BTC - 15 min prices_${runId}.csv`);
        this.eth15mPath = path.join(livePricesDir, `ETH - 15 min prices_${runId}.csv`);
        this.btc1hPath = path.join(livePricesDir, `BTC - 1 hour prices_${runId}.csv`);
        this.eth1hPath = path.join(livePricesDir, `ETH - 1 hour prices_${runId}.csv`);

        this.initializeCsvFiles();
    }

    /**
     * Initialize CSV files with headers
     */
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

            // Always write headers for new run-specific files
            fs.writeFileSync(this.btc15mPath, headers + '\n', 'utf8');
            console.log(`✓ Created CSV file: ${this.btc15mPath}`);
            fs.writeFileSync(this.eth15mPath, headers + '\n', 'utf8');
            console.log(`✓ Created CSV file: ${this.eth15mPath}`);
            fs.writeFileSync(this.btc1hPath, headers + '\n', 'utf8');
            console.log(`✓ Created CSV file: ${this.btc1hPath}`);
            fs.writeFileSync(this.eth1hPath, headers + '\n', 'utf8');
            console.log(`✓ Created CSV file: ${this.eth1hPath}`);
        } catch (error) {
            console.error(`✗ Failed to create price CSV files:`, error);
        }
    }

    /**
     * Log price for a market (called when prices update)
     *
     * This method writes price rows at fixed intervals (every 0.5 seconds).
     * Trade entries (WATCH/PAPER) are accumulated between writes.
     *
     * IMPORTANT: Only writes when called WITHOUT an entryType (pure price update).
     * When called WITH entryType (trade), it just records the trade for the next write.
     */
    logPrice(marketSlug: string, marketTitle: string, priceUp: number, priceDown: number, entryType?: 'WATCH' | 'PAPER', notes?: string): void {
        const { type, timeframe } = extractMarketKey(marketSlug, marketTitle);

        if (!type || !timeframe) {
            return; // Not a BTC/ETH market we track
        }

        const timestamp = Date.now();
        const marketKey = `${type}-${timeframe}`;

        // Determine which file to write to
        let filePath: string;
        if (type === 'BTC' && timeframe === '15m') {
            filePath = this.btc15mPath;
        } else if (type === 'ETH' && timeframe === '15m') {
            filePath = this.eth15mPath;
        } else if (type === 'BTC' && timeframe === '1h') {
            filePath = this.btc1hPath;
        } else if (type === 'ETH' && timeframe === '1h') {
            filePath = this.eth1hPath;
        } else {
            return; // Unknown combination
        }

        // Get or create pending entry for this market
        let pending = this.pendingEntries.get(marketKey);
        if (!pending) {
            pending = {
                priceUp,
                priceDown,
                watchTrades: [],
                paperTrades: [],
                lastUpdate: timestamp,
            };
            this.pendingEntries.set(marketKey, pending);
        }

        // Update prices to latest
        pending.priceUp = priceUp;
        pending.priceDown = priceDown;
        pending.lastUpdate = timestamp;

        // Add trade to appropriate list if this is a trade entry
        if (entryType === 'WATCH' && notes) {
            pending.watchTrades.push(notes);
            // Don't write row for trade entries - just accumulate
            return;
        } else if (entryType === 'PAPER' && notes) {
            pending.paperTrades.push(notes);
            // Don't write row for trade entries - just accumulate
            return;
        }

        // Only write rows for pure price updates (no entryType)
        // This ensures we get regular price snapshots with gaps where no trades happened

        // Check if we should write to CSV (interval elapsed)
        const lastLogged = timeframe === '15m'
            ? this.lastLogged15m.get(marketKey)
            : this.lastLogged1h.get(marketKey);

        // Log prices every 0.5 seconds for live chart accuracy
        const intervalMs = 500; // 0.5 seconds for all markets

        const shouldWrite = lastLogged === undefined ||
            (timestamp - lastLogged) >= intervalMs;

        if (!shouldWrite) {
            return;
        }

        // Update last logged time
        if (timeframe === '15m') {
            this.lastLogged15m.set(marketKey, timestamp);
        } else {
            this.lastLogged1h.set(marketKey, timestamp);
        }

        // Build the row with aggregated data
        const timeBreakdown = getTimestampBreakdown(timestamp);
        const date = new Date(timestamp).toISOString();

        const hasWatchTrades = pending.watchTrades.length > 0;
        const hasPaperTrades = pending.paperTrades.length > 0;

        // Aggregate notes: show count and summary
        const allNotes: string[] = [];
        if (hasWatchTrades) {
            allNotes.push(`Watch(${pending.watchTrades.length}): ${pending.watchTrades.slice(-3).join('; ')}`);
        }
        if (hasPaperTrades) {
            allNotes.push(`Paper(${pending.paperTrades.length}): ${pending.paperTrades.slice(-3).join('; ')}`);
        }
        const notesField = allNotes.length > 0
            ? `"${allNotes.join(' | ').replace(/"/g, '""')}"`
            : '';

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
            pending.priceUp.toFixed(4),
            pending.priceDown.toFixed(4),
            hasWatchTrades ? 'YES' : '',
            hasPaperTrades ? 'YES' : '',
            notesField,
        ].join(',');

        try {
            fs.appendFileSync(filePath, row + '\n', 'utf8');

            // Clear pending trades after writing (keep prices for next interval)
            pending.watchTrades = [];
            pending.paperTrades = [];
        } catch (error) {
            console.error(`Failed to log price to ${filePath}:`, error);
        }
    }

    /**
     * Mark a watch mode entry
     */
    markWatchEntry(marketSlug: string, marketTitle: string, priceUp: number, priceDown: number, notes?: string): void {
        this.logPrice(marketSlug, marketTitle, priceUp, priceDown, 'WATCH', notes);
    }

    /**
     * Mark a paper mode entry
     */
    markPaperEntry(marketSlug: string, marketTitle: string, priceUp: number, priceDown: number, notes?: string): void {
        this.logPrice(marketSlug, marketTitle, priceUp, priceDown, 'PAPER', notes);
    }
}

export default new PriceStreamLogger();



