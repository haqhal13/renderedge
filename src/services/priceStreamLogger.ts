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
    // Track logged trades to prevent duplicates (using transactionHash for paper, trade key for watch)
    private loggedTradeEntries: Set<string> = new Set();

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

        // Try to find existing CSV files from watcher mode, otherwise use current runId
        const runId = getRunId();
        this.btc15mPath = this.findOrCreatePriceFile(livePricesDir, 'BTC', '15 min', runId);
        this.eth15mPath = this.findOrCreatePriceFile(livePricesDir, 'ETH', '15 min', runId);
        this.btc1hPath = this.findOrCreatePriceFile(livePricesDir, 'BTC', '1 hour', runId);
        this.eth1hPath = this.findOrCreatePriceFile(livePricesDir, 'ETH', '1 hour', runId);

        this.initializeCsvFiles();
    }

    /**
     * Find existing price CSV file or return path for new file
     * Looks for the most recent file matching the pattern to allow paper mode to append to watcher files
     */
    private findOrCreatePriceFile(livePricesDir: string, asset: string, timeframe: string, currentRunId: string): string {
        try {
            // Pattern to match: "BTC - 15 min prices_YYYYMMDD-HHMMSS.csv" or "BTC - 1 hour prices_YYYYMMDD-HHMMSS.csv"
            // Escape special regex characters and handle spaces
            const escapedTimeframe = timeframe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
            const pattern = new RegExp(`^${asset} - ${escapedTimeframe} prices_\\d{8}-\\d{6}\\.csv$`);
            
            // Get all files matching the pattern
            const files = fs.readdirSync(livePricesDir)
                .filter(file => pattern.test(file))
                .map(file => ({
                    name: file,
                    path: path.join(livePricesDir, file),
                    stats: fs.statSync(path.join(livePricesDir, file))
                }))
                .sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime()); // Sort by modification time, newest first

            // If we found existing files, use the most recent one (allows paper mode to append to watcher files)
            if (files.length > 0) {
                const existingFile = files[0];
                console.log(`✓ Reusing existing CSV file: ${existingFile.name}`);
                return existingFile.path;
            }
        } catch (error) {
            // If there's an error reading directory, fall through to create new file
        }

        // No existing file found, create new one with current runId
        return path.join(livePricesDir, `${asset} - ${timeframe} prices_${currentRunId}.csv`);
    }

    /**
     * Flush a pending entry to CSV file immediately (used when trades are logged)
     */
    private flushPendingEntry(marketKey: string, filePath: string, pending: PendingEntry): void {
        try {
            const timestamp = Date.now();
            const timeBreakdown = getTimestampBreakdown(timestamp);
            const date = new Date(timestamp).toISOString();

            const hasWatchTrades = pending.watchTrades.length > 0;
            const hasPaperTrades = pending.paperTrades.length > 0;

            // Aggregate notes: show clear trade entries with WATCH/PAPER prefix
            const allNotes: string[] = [];
            if (hasWatchTrades) {
                pending.watchTrades.forEach(trade => {
                    allNotes.push(`WATCH: ${trade}`);
                });
            }
            if (hasPaperTrades) {
                pending.paperTrades.forEach(trade => {
                    allNotes.push(`PAPER: ${trade}`);
                });
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

            fs.appendFileSync(filePath, row + '\n', 'utf8');

            // Clear pending trades after writing (keep prices for next interval)
            pending.watchTrades = [];
            pending.paperTrades = [];

            // Update last logged time to prevent duplicate writes from regular price updates
            const timeframe = marketKey.includes('15m') ? '15m' : '1h';
            if (timeframe === '15m') {
                this.lastLogged15m.set(marketKey, timestamp);
            } else {
                this.lastLogged1h.set(marketKey, timestamp);
            }
        } catch (error) {
            console.error(`Failed to flush pending entry to ${filePath}:`, error);
        }
    }

    /**
     * Initialize CSV files with headers (only if file doesn't exist)
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

            // Only write headers if file doesn't exist (allows appending to existing files)
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
     * Log price for a market (called when prices update)
     *
     * This method writes price rows at fixed intervals (every 0.5 seconds).
     * Trade entries (WATCH/PAPER) are accumulated between writes.
     *
     * IMPORTANT: Only writes when called WITHOUT an entryType (pure price update).
     * When called WITH entryType (trade), it just records the trade for the next write.
     */
    logPrice(marketSlug: string, marketTitle: string, priceUp: number, priceDown: number, entryType?: 'WATCH' | 'PAPER', notes?: string, transactionHash?: string): void {
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
            // If no pending entry exists yet, create one with the passed prices
            // (This handles the edge case where a trade happens before any price logging)
            pending = {
                priceUp: priceUp > 0 ? priceUp : 0.5,
                priceDown: priceDown > 0 ? priceDown : 0.5,
                watchTrades: [],
                paperTrades: [],
                lastUpdate: timestamp,
            };
            this.pendingEntries.set(marketKey, pending);
        }

        // Add trade to appropriate list if this is a trade entry
        // For trade entries, update prices with the fetched prices (from tradeLogger)
        // to ensure we show the current market prices at the time the trade is logged
        if (entryType === 'WATCH' && notes) {
            // Update prices to the fetched prices (current market prices when trade was logged)
            pending.priceUp = priceUp > 0 ? priceUp : pending.priceUp;
            pending.priceDown = priceDown > 0 ? priceDown : pending.priceDown;
            pending.lastUpdate = timestamp;
            // Create unique key for this trade entry to prevent duplicates
            // Use transactionHash if available, otherwise use marketKey + notes as fallback
            const tradeEntryKey = transactionHash 
                ? `WATCH:${transactionHash}` 
                : `WATCH:${marketKey}:${notes}`;
            
            if (this.loggedTradeEntries.has(tradeEntryKey)) {
                return; // Already logged this trade entry
            }
            this.loggedTradeEntries.add(tradeEntryKey);
            
            pending.watchTrades.push(notes);
            // Force a write when trade is logged to ensure it appears in CSV
            this.flushPendingEntry(marketKey, filePath, pending);
            return;
        } else if (entryType === 'PAPER' && notes) {
            // Create unique key for this trade entry to prevent duplicates using transactionHash
            // Paper trades always have transactionHash, but handle missing case for safety
            const tradeEntryKey = transactionHash 
                ? `PAPER:${transactionHash}` 
                : `PAPER:${marketKey}:${notes}`;
            
            if (this.loggedTradeEntries.has(tradeEntryKey)) {
                return; // Already logged this trade entry
            }
            this.loggedTradeEntries.add(tradeEntryKey);
            
            // Update prices to the fetched prices (current market prices when trade was logged)
            pending.priceUp = priceUp > 0 ? priceUp : pending.priceUp;
            pending.priceDown = priceDown > 0 ? priceDown : pending.priceDown;
            pending.lastUpdate = timestamp;
            
            pending.paperTrades.push(notes);
            // Force a write when trade is logged to ensure it appears in CSV
            this.flushPendingEntry(marketKey, filePath, pending);
            return;
        }

        // For regular price updates (no entryType), update prices to latest
        pending.priceUp = priceUp;
        pending.priceDown = priceDown;
        pending.lastUpdate = timestamp;

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

        // Aggregate notes: show clear trade entries with WATCH/PAPER prefix
        const allNotes: string[] = [];
        if (hasWatchTrades) {
            // Show all watch trades clearly labeled
            pending.watchTrades.forEach(trade => {
                allNotes.push(`WATCH: ${trade}`);
            });
        }
        if (hasPaperTrades) {
            // Show all paper trades clearly labeled
            pending.paperTrades.forEach(trade => {
                allNotes.push(`PAPER: ${trade}`);
            });
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
     * Get current pending prices for a market (returns current live prices from pending entry)
     */
    getCurrentPrices(marketSlug: string, marketTitle: string): { priceUp: number; priceDown: number } | null {
        const { type, timeframe } = extractMarketKey(marketSlug, marketTitle);
        if (!type || !timeframe) {
            return null;
        }
        const marketKey = `${type}-${timeframe}`;
        const pending = this.pendingEntries.get(marketKey);
        if (pending && pending.priceUp > 0 && pending.priceDown > 0) {
            return { priceUp: pending.priceUp, priceDown: pending.priceDown };
        }
        return null;
    }

    /**
     * Mark a watch mode entry
     * For trade entries, uses current pending prices (from regular price logging) if available,
     * otherwise falls back to the passed prices (edge case for first trade before price logging)
     */
    markWatchEntry(marketSlug: string, marketTitle: string, priceUp: number, priceDown: number, notes?: string, transactionHash?: string): void {
        this.logPrice(marketSlug, marketTitle, priceUp, priceDown, 'WATCH', notes, transactionHash);
    }

    /**
     * Mark a paper mode entry
     * For trade entries, uses current pending prices (from regular price logging) if available,
     * otherwise falls back to the passed prices (edge case for first trade before price logging)
     */
    markPaperEntry(marketSlug: string, marketTitle: string, priceUp: number, priceDown: number, notes?: string, transactionHash?: string): void {
        this.logPrice(marketSlug, marketTitle, priceUp, priceDown, 'PAPER', notes, transactionHash);
    }
}

export default new PriceStreamLogger();



