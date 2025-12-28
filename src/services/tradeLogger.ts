import * as fs from 'fs';
import * as path from 'path';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import priceStreamLogger from './priceStreamLogger';
import { getRunId } from '../utils/runId';

interface TradeLog {
    timestamp: number;
    date: string;
    traderAddress: string;
    traderName?: string;
    transactionHash: string;
    conditionId: string;
    marketName: string;
    marketSlug?: string;
    side: string; // BUY or SELL
    outcome: string; // UP or DOWN
    outcomeIndex: number;
    asset: string;
    size: number; // Shares
    price: number; // Price per share
    usdcSize: number; // Total USD value
    priceUp: number; // Market price for UP at time of trade
    priceDown: number; // Market price for DOWN at time of trade
    marketKey?: string;
}

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
 * Track average cost per share for UP and DOWN positions per market
 */
interface MarketAverageCosts {
    totalCostUp: number;
    sharesUp: number;
    totalCostDown: number;
    sharesDown: number;
}

class TradeLogger {
    private csvFilePath: string;
    private loggedTrades: Set<string> = new Set(); // Track trades already logged
    // Track running weighted average costs per market (by conditionId)
    private marketAverageCosts: Map<string, MarketAverageCosts> = new Map();

    constructor() {
        // Initialize CSV file path - use paper folder if in PAPER mode, otherwise watcher folder
        const logsDir = path.join(process.cwd(), 'logs');
        const isPaperMode = ENV.PAPER_MODE;
        const targetDir = path.join(logsDir, isPaperMode ? 'paper' : 'watcher');
        const fileName = isPaperMode ? 'Paper Trades' : 'Watcher Trades';
        
        // Create directories
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        
        const runId = getRunId();
        this.csvFilePath = path.join(targetDir, `${fileName}_${runId}.csv`);
        this.initializeCsvFile();
    }

    /**
     * Initialize CSV file with headers (always create new file for each run)
     */
    private initializeCsvFile(): void {
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
                'Price per Share ($)',
                'Total Value ($)',
                'Market Price UP ($)',
                'Market Price DOWN ($)',
                'Price Difference UP',
                'Price Difference DOWN',
                'Entry Type',
                'Average Cost Per Share UP ($)',
                'Average Cost Per Share DOWN ($)',
                // Paper-specific columns (kept for 1:1 CSV format)
                'Skew Magnitude',
                'Dominant Side',
                'Target Allocation',
                'Reason'
            ].join(',');
            fs.writeFileSync(this.csvFilePath, headers + '\n', 'utf8');
            console.log(`✓ Created CSV file: ${this.csvFilePath}`);
        } catch (error) {
            console.error(`✗ Failed to create CSV file ${this.csvFilePath}:`, error);
        }
    }

    /**
     * Fetch market prices (UP and DOWN) for a condition ID
     */
    private async fetchMarketPrices(conditionId: string): Promise<{ priceUp: number; priceDown: number }> {
        if (!conditionId) {
            return { priceUp: 0.5, priceDown: 0.5 };
        }

        try {
            // Try Gamma API first (more reliable for prices)
            // Gamma's /markets/{id} expects a market ID, not a condition_id,
            // so we query the markets list and match on condition_id.
            const gammaUrl = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500`;
            const marketList = await fetchData(gammaUrl).catch(() => null);

            if (Array.isArray(marketList)) {
                const marketData = marketList.find((m: any) => m.condition_id === conditionId);
                if (marketData && marketData.tokens && Array.isArray(marketData.tokens)) {
                let priceUp = 0.5;
                let priceDown = 0.5;
                let foundUp = false;
                let foundDown = false;

                for (const token of marketData.tokens) {
                    const outcome = (token.outcome || '').toLowerCase();
                    const price = parseFloat(token.price) || 0.5;

                    // Determine if this is UP or DOWN
                    if (outcome.includes('up') || outcome.includes('yes') || outcome.includes('higher') || outcome.includes('above')) {
                        priceUp = price;
                        foundUp = true;
                    } else if (outcome.includes('down') || outcome.includes('no') || outcome.includes('lower') || outcome.includes('below')) {
                        priceDown = price;
                        foundDown = true;
                    }
                }

                // If we found both prices, normalize them
                if (foundUp && foundDown) {
                    const total = priceUp + priceDown;
                    if (total > 0 && total !== 1.0) {
                        // Normalize if they don't sum to 1
                        priceUp = priceUp / total;
                        priceDown = priceDown / total;
                    }
                    return { priceUp, priceDown };
                } else if (foundUp || foundDown) {
                    // If we only found one, calculate the other
                    if (foundUp) {
                        priceDown = 1.0 - priceUp;
                    } else {
                        priceUp = 1.0 - priceDown;
                    }
                    return { priceUp, priceDown };
                }
                }
            }
        } catch (error) {
            // Continue to fallback methods
        }

        // Fallback: try to get prices from positions API
        try {
            for (const traderAddress of ENV.USER_ADDRESSES) {
                try {
                    const positions = await fetchData(
                        `https://data-api.polymarket.com/positions?user=${traderAddress}`
                    ).catch(() => null);

                    if (Array.isArray(positions)) {
                        let priceUp = 0.5;
                        let priceDown = 0.5;
                        let foundUp = false;
                        let foundDown = false;

                        for (const pos of positions) {
                            if (pos.conditionId === conditionId && pos.curPrice !== undefined) {
                                const outcome = (pos.outcome || '').toLowerCase();
                                const price = parseFloat(pos.curPrice) || 0.5;

                                if (outcome.includes('up') || outcome.includes('yes')) {
                                    priceUp = price;
                                    foundUp = true;
                                } else if (outcome.includes('down') || outcome.includes('no')) {
                                    priceDown = price;
                                    foundDown = true;
                                }

                                if (foundUp && foundDown) {
                                    // Normalize
                                    const total = priceUp + priceDown;
                                    if (total > 0 && total !== 1.0) {
                                        priceUp = priceUp / total;
                                        priceDown = priceDown / total;
                                    }
                                    return { priceUp, priceDown };
                                }
                            }
                        }
                        
                        // If we found one, calculate the other
                        if (foundUp) {
                            priceDown = 1.0 - priceUp;
                            return { priceUp, priceDown };
                        } else if (foundDown) {
                            priceUp = 1.0 - priceDown;
                            return { priceUp, priceDown };
                        }
                    }
                } catch (e) {
                    // Continue to next trader
                }
            }
        } catch (error) {
            // Silently fail
        }

        // Default: return 0.5 for both if we can't fetch
        return { priceUp: 0.5, priceDown: 0.5 };
    }

    /**
     * Determine if outcome is UP or DOWN
     */
    private isUpOutcome(activity: any): boolean {
        // Primary method: use outcomeIndex (0 = UP/YES, 1 = DOWN/NO typically)
        if (activity.outcomeIndex !== undefined) {
            return activity.outcomeIndex === 0;
        }
        
        // Fallback: check outcome and asset strings
        const outcome = (activity.outcome || '').toLowerCase();
        const asset = (activity.asset || '').toLowerCase();
        
        // Check for UP indicators
        if (outcome.includes('up') || 
            outcome.includes('higher') ||
            outcome.includes('above') ||
            outcome.includes('yes') ||
            asset.includes('yes') ||
            asset.includes('up')) {
            return true;
        }
        
        // Check for DOWN indicators
        if (outcome.includes('down') ||
            outcome.includes('lower') ||
            outcome.includes('below') ||
            outcome.includes('no') ||
            asset.includes('no') ||
            asset.includes('down')) {
            return false;
        }
        
        // Default: assume first outcome is UP
        return true;
    }

    /**
     * Log a trade to CSV
     */
    async logTrade(activity: any, traderAddress: string): Promise<void> {
        // Create unique key for this trade
        const tradeKey = `${traderAddress}:${activity.transactionHash}:${activity.asset}`;
        
        // Skip if already logged
        if (this.loggedTrades.has(tradeKey)) {
            return;
        }

        try {
            const isUp = this.isUpOutcome(activity);
            const outcome = isUp ? 'UP' : 'DOWN';
            const tradePrice = parseFloat(activity.price || '0');

            // For PAPER trades, use the actual market prices passed in (NOT trade price!)
            // For WATCH trades, fetch current market prices from API
            let prices: { priceUp: number; priceDown: number };
            if (traderAddress === 'PAPER' && activity.marketPriceUp !== undefined && activity.marketPriceDown !== undefined) {
                // PAPER trades include actual market prices - use them for accurate comparison
                // This allows us to see the execution price difference vs mid-market
                prices = { priceUp: activity.marketPriceUp, priceDown: activity.marketPriceDown };
            } else if (traderAddress === 'PAPER') {
                // Fallback for older PAPER trades without market prices
                if (isUp) {
                    prices = { priceUp: tradePrice, priceDown: 1.0 - tradePrice };
                } else {
                    prices = { priceUp: 1.0 - tradePrice, priceDown: tradePrice };
                }
            } else {
                // WATCH trades - fetch current market prices
                prices = await this.fetchMarketPrices(activity.conditionId);
            }

            // Extract market key (similar to marketTracker logic)
            const marketKey = this.extractMarketKey(activity);

            const timestamp = activity.timestamp ? activity.timestamp * 1000 : Date.now();
            const date = new Date(timestamp).toISOString();
            const timeBreakdown = getTimestampBreakdown(timestamp);
            const size = parseFloat(activity.size || '0');
            const usdcSize = parseFloat(activity.usdcSize || '0');
            
            // Calculate price differences (how much better/worse than market price)
            const priceDifferenceUp = isUp ? (tradePrice - prices.priceUp) : 0;
            const priceDifferenceDown = !isUp ? (tradePrice - prices.priceDown) : 0;
            
            // Update and get average costs for this market
            const conditionId = activity.conditionId || '';
            let avgCosts = this.marketAverageCosts.get(conditionId);
            if (!avgCosts) {
                avgCosts = {
                    totalCostUp: 0,
                    sharesUp: 0,
                    totalCostDown: 0,
                    sharesDown: 0,
                };
                this.marketAverageCosts.set(conditionId, avgCosts);
            }
            
            // Update running weighted average based on trade
            if (isUp) {
                // For UP trades: add to UP position
                avgCosts.totalCostUp += usdcSize;
                avgCosts.sharesUp += size;
            } else {
                // For DOWN trades: add to DOWN position
                avgCosts.totalCostDown += usdcSize;
                avgCosts.sharesDown += size;
            }
            
            // Calculate current average costs
            const avgCostUp = avgCosts.sharesUp > 0 ? avgCosts.totalCostUp / avgCosts.sharesUp : 0;
            const avgCostDown = avgCosts.sharesDown > 0 ? avgCosts.totalCostDown / avgCosts.sharesDown : 0;
            
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
                traderAddress,
                activity.name || activity.pseudonym || '',
                activity.transactionHash || '',
                activity.conditionId || '',
                `"${(activity.title || activity.slug || 'Unknown').replace(/"/g, '""')}"`,
                activity.slug || '',
                marketKey,
                activity.side || 'BUY',
                outcome,
                activity.outcomeIndex ?? (isUp ? 0 : 1),
                activity.asset || '',
                size.toFixed(4),
                tradePrice.toFixed(4),
                usdcSize.toFixed(2),
                prices.priceUp.toFixed(4),
                prices.priceDown.toFixed(4),
                priceDifferenceUp.toFixed(4),
                priceDifferenceDown.toFixed(4),
                traderAddress === 'PAPER' ? 'PAPER' : 'WATCH', // Entry Type
                avgCostUp > 0 ? avgCostUp.toFixed(4) : '', // Average Cost Per Share UP
                avgCostDown > 0 ? avgCostDown.toFixed(4) : '', // Average Cost Per Share DOWN
                '', // Skew Magnitude (N/A for watcher bot)
                '', // Dominant Side (N/A for watcher bot)
                '', // Target Allocation (N/A for watcher bot)
                ''  // Reason (N/A for watcher bot)
            ].join(',');

            // Append to CSV file
            fs.appendFileSync(this.csvFilePath, row + '\n', 'utf8');
            this.loggedTrades.add(tradeKey);

            // Log to price stream with appropriate entry marker (WATCH or PAPER)
            const marketTitle = activity.title || activity.slug || 'Unknown';
            const entryType = traderAddress === 'PAPER' ? 'PAPER' : 'WATCH';
            const entryNotes = `${outcome} ${size.toFixed(4)} shares @ $${tradePrice.toFixed(4)}`;
            
            if (entryType === 'PAPER') {
                priceStreamLogger.markPaperEntry(
                    activity.slug || '',
                    marketTitle,
                    prices.priceUp,
                    prices.priceDown,
                    entryNotes,
                    activity.transactionHash
                );
            } else {
                priceStreamLogger.markWatchEntry(
                    activity.slug || '',
                    marketTitle,
                    prices.priceUp,
                    prices.priceDown,
                    entryNotes,
                    activity.transactionHash
                );
            }
        } catch (error) {
            console.error(`Failed to log trade to CSV: ${error}`);
        }
    }

    /**
     * Extract market key from activity (matches priceStreamLogger logic)
     */
    private extractMarketKey(activity: any): string {
        const slug = activity?.slug || activity?.eventSlug || '';
        const title = activity?.title || activity?.asset || '';
        const searchText = `${slug} ${title}`.toLowerCase();

        if (!searchText.trim()) return 'Unknown';

        const isBTC = searchText.includes('bitcoin') || searchText.includes('btc');
        const isETH = searchText.includes('ethereum') || searchText.includes('eth');

        if (!isBTC && !isETH) {
            // Use condition ID if available for non-BTC/ETH markets
            if (activity.conditionId) {
                return `CID-${activity.conditionId.substring(0, 10)}`;
            }
            return 'Unknown';
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
        // Prioritize 15min (explicit or time range), then hourly (explicit or pattern), otherwise generic
        const timeframe = is15Min ? 'UpDown-15' : (hasHourly || isHourlyPattern) ? 'UpDown-1h' : '';

        return timeframe ? `${type}-${timeframe}` : type;
    }
}

export default new TradeLogger();
