import * as fs from 'fs';
import * as path from 'path';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import priceStreamLogger from './priceStreamLogger';
import { getRunId } from '../utils/runId';
import marketTracker from './marketTracker';

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
    private loggedTrades: Set<string> = new Set(); // Track trades already logged
    // Track running weighted average costs per market (by conditionId)
    private marketAverageCosts: Map<string, MarketAverageCosts> = new Map();
    // Per-market CSV files: marketName -> filePath
    private marketCsvFiles: Map<string, string> = new Map();
    // Base directory for market CSV files
    private marketsDir: string;
    private runId: string;

    constructor() {
        // Initialize directories
        const logsDir = path.join(process.cwd(), 'logs');
        const isPaperMode = ENV.PAPER_MODE;
        const baseDir = path.join(logsDir, isPaperMode ? 'paper' : 'watcher');
        this.marketsDir = path.join(baseDir, 'markets');

        // Create directories
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }
        if (!fs.existsSync(this.marketsDir)) {
            fs.mkdirSync(this.marketsDir, { recursive: true });
        }

        this.runId = getRunId();
        console.log(`✓ Trade logger initialized - markets will be saved to: ${this.marketsDir}`);
    }

    /**
     * Sanitize market name for use as a filename
     * Removes invalid characters and creates a clean, readable filename
     */
    private sanitizeMarketName(marketName: string): string {
        // Remove or replace invalid filename characters
        let sanitized = marketName
            .replace(/[<>:"/\\|?*]/g, '') // Remove invalid chars
            .replace(/\s+/g, '_') // Replace spaces with underscores
            .replace(/_-_/g, '-') // Clean up " - " patterns
            .replace(/,/g, '') // Remove commas
            .replace(/__+/g, '_') // Replace multiple underscores with single
            .replace(/^_|_$/g, '') // Remove leading/trailing underscores
            .trim();

        // Limit length to avoid filesystem issues
        if (sanitized.length > 100) {
            sanitized = sanitized.substring(0, 100);
        }

        return sanitized || 'Unknown_Market';
    }

    /**
     * Get or create CSV file for a specific market
     */
    private getMarketCsvPath(marketName: string): string {
        // Check if we already have a CSV for this market
        if (this.marketCsvFiles.has(marketName)) {
            return this.marketCsvFiles.get(marketName)!;
        }

        // Create new CSV file for this market
        const sanitizedName = this.sanitizeMarketName(marketName);
        const fileName = `${sanitizedName}_${this.runId}.csv`;
        const filePath = path.join(this.marketsDir, fileName);

        // Initialize the CSV with headers
        this.initializeMarketCsvFile(filePath, marketName);

        // Cache the path
        this.marketCsvFiles.set(marketName, filePath);

        return filePath;
    }

    /**
     * Initialize a market-specific CSV file with headers
     */
    private initializeMarketCsvFile(filePath: string, marketName: string): void {
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
            fs.writeFileSync(filePath, headers + '\n', 'utf8');
            console.log(`✓ Created market CSV: ${path.basename(filePath)}`);
        } catch (error) {
            console.error(`✗ Failed to create market CSV file ${filePath}:`, error);
        }
    }

    /**
     * Fetch REAL orderbook prices (ASK for buying) from CLOB API
     * Returns the actual price you'd pay to buy UP or DOWN
     */
    private async fetchOrderbookPrices(assetUpId: string, assetDownId: string): Promise<{ priceUp: number; priceDown: number } | null> {
        try {
            const [bookUp, bookDown] = await Promise.all([
                fetchData(`https://clob.polymarket.com/book?token_id=${assetUpId}`).catch(() => null),
                fetchData(`https://clob.polymarket.com/book?token_id=${assetDownId}`).catch(() => null)
            ]);

            let priceUp: number | null = null;
            let priceDown: number | null = null;

            // For UP: Get the ASK price (what you pay to buy)
            if (bookUp?.asks?.length > 0) {
                const bestAskUp = Math.min(...bookUp.asks.map((a: any) => parseFloat(a.price || 1)));
                if (bestAskUp > 0 && bestAskUp <= 1) {
                    priceUp = bestAskUp;
                }
            }

            // For DOWN: Get the ASK price (what you pay to buy)
            if (bookDown?.asks?.length > 0) {
                const bestAskDown = Math.min(...bookDown.asks.map((a: any) => parseFloat(a.price || 1)));
                if (bestAskDown > 0 && bestAskDown <= 1) {
                    priceDown = bestAskDown;
                }
            }

            if (priceUp !== null && priceDown !== null) {
                return { priceUp, priceDown };
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Fetch market prices (UP and DOWN) for a condition ID
     * Now tries to get REAL orderbook prices first
     */
    private async fetchMarketPrices(conditionId: string, assetUpId?: string, assetDownId?: string): Promise<{ priceUp: number; priceDown: number }> {
        if (!conditionId) {
            return { priceUp: 0.5, priceDown: 0.5 };
        }

        // If we have asset IDs, try to get REAL orderbook prices first
        if (assetUpId && assetDownId) {
            const orderbookPrices = await this.fetchOrderbookPrices(assetUpId, assetDownId);
            if (orderbookPrices) {
                return orderbookPrices;
            }
        }

        try {
            // Try Gamma API to get asset IDs, then fetch REAL orderbook prices
            const gammaUrl = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500`;
            const marketList = await fetchData(gammaUrl).catch(() => null);

            if (Array.isArray(marketList)) {
                const marketData = marketList.find((m: any) => m.condition_id === conditionId);
                if (marketData && marketData.tokens && Array.isArray(marketData.tokens)) {
                    // Extract asset IDs for UP and DOWN tokens
                    let tokenUpId: string | null = null;
                    let tokenDownId: string | null = null;

                    for (const token of marketData.tokens) {
                        const outcome = (token.outcome || '').toLowerCase();
                        const tokenId = token.token_id;

                        if (outcome.includes('up') || outcome.includes('yes') || outcome.includes('higher') || outcome.includes('above')) {
                            tokenUpId = tokenId;
                        } else if (outcome.includes('down') || outcome.includes('no') || outcome.includes('lower') || outcome.includes('below')) {
                            tokenDownId = tokenId;
                        }
                    }

                    // If we have both token IDs, fetch REAL orderbook prices
                    if (tokenUpId && tokenDownId) {
                        const orderbookPrices = await this.fetchOrderbookPrices(tokenUpId, tokenDownId);
                        if (orderbookPrices) {
                            return orderbookPrices;
                        }
                    }

                    // Fallback to mid-market prices from Gamma if orderbook fetch failed
                    let priceUp = 0.5;
                    let priceDown = 0.5;
                    let foundUp = false;
                    let foundDown = false;

                    for (const token of marketData.tokens) {
                        const outcome = (token.outcome || '').toLowerCase();
                        const price = parseFloat(token.price) || 0.5;

                        if (outcome.includes('up') || outcome.includes('yes') || outcome.includes('higher') || outcome.includes('above')) {
                            priceUp = price;
                            foundUp = true;
                        } else if (outcome.includes('down') || outcome.includes('no') || outcome.includes('lower') || outcome.includes('below')) {
                            priceDown = price;
                            foundDown = true;
                        }
                    }

                    if (foundUp && foundDown) {
                        const total = priceUp + priceDown;
                        if (total > 0 && total !== 1.0) {
                            priceUp = priceUp / total;
                            priceDown = priceDown / total;
                        }
                        return { priceUp, priceDown };
                    } else if (foundUp || foundDown) {
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

            // Extract market key (similar to marketTracker logic)
            const marketKey = this.extractMarketKey(activity);

            const timestamp = activity.timestamp ? activity.timestamp * 1000 : Date.now();
            const date = new Date(timestamp).toISOString();
            const timeBreakdown = getTimestampBreakdown(timestamp);
            const size = parseFloat(activity.size || '0');
            const usdcSize = parseFloat(activity.usdcSize || '0');
            
            // Fetch EXACT prices from CLOB API for both UP and DOWN
            // This gives us the real orderbook prices instead of calculating 1 - price
            let prices: { priceUp: number; priceDown: number };

            if (activity.marketPriceUp !== undefined && activity.marketPriceDown !== undefined) {
                // Use actual market prices passed (paper trades or injected live prices from watcher)
                prices = {
                    priceUp: activity.marketPriceUp,
                    priceDown: activity.marketPriceDown
                };
                // Only log in non-watcher mode (verbose logging clutters dashboard)
                if (!ENV.TRACK_ONLY_MODE) {
                    console.log(`📊 LIVE PRICES: ${marketKey} UP=$${prices.priceUp.toFixed(4)} DOWN=$${prices.priceDown.toFixed(4)} (injected)`);
                }
            } else {
                // For WATCHER trades: Use prices from marketTracker (already fetched from orderbook)
                // This is more reliable than fetching again since marketTracker continuously updates prices
                let foundMarket: any = null;

                // Try to find the market in marketTracker by multiple methods
                const trackerMarkets = marketTracker.getMarkets();
                const activitySlug = activity.slug || '';
                const activityConditionId = activity.conditionId || '';

                // Method 1: Direct match by conditionId or slug
                for (const [marketKey, market] of trackerMarkets) {
                    if (market.conditionId === activityConditionId ||
                        market.marketSlug === activitySlug) {
                        foundMarket = market;
                        break;
                    }
                }

                // Method 2: If not found, try partial slug match (e.g., btc-updown-15m matches)
                if (!foundMarket && activitySlug) {
                    const slugLower = activitySlug.toLowerCase();
                    for (const [marketKey, market] of trackerMarkets) {
                        const marketSlugLower = (market.marketSlug || '').toLowerCase();
                        // Check if slugs share the same base pattern
                        if (slugLower.includes('btc-updown-15m') && marketSlugLower.includes('btc-updown-15m')) {
                            foundMarket = market;
                            break;
                        }
                        if (slugLower.includes('eth-updown-15m') && marketSlugLower.includes('eth-updown-15m')) {
                            foundMarket = market;
                            break;
                        }
                        if (slugLower.includes('btc') && slugLower.includes('1h') && marketSlugLower.includes('btc') && marketKey.includes('1h')) {
                            foundMarket = market;
                            break;
                        }
                        if (slugLower.includes('eth') && slugLower.includes('1h') && marketSlugLower.includes('eth') && marketKey.includes('1h')) {
                            foundMarket = market;
                            break;
                        }
                    }
                }

                // Method 3: Try by marketKey pattern from the extracted key
                if (!foundMarket) {
                    const extractedKey = this.extractMarketKey(activity);
                    if (extractedKey && extractedKey !== 'Unknown') {
                        for (const [marketKey, market] of trackerMarkets) {
                            if (marketKey.includes(extractedKey) || extractedKey.includes(marketKey.split('-').slice(0,2).join('-'))) {
                                foundMarket = market;
                                break;
                            }
                        }
                    }
                }

                // Use cached prices from marketTracker if available (these are the real orderbook prices)
                if (foundMarket && foundMarket.currentPriceUp !== undefined && foundMarket.currentPriceDown !== undefined) {
                    prices = {
                        priceUp: foundMarket.currentPriceUp,
                        priceDown: foundMarket.currentPriceDown
                    };
                    // Debug log when we successfully use cached prices
                    console.log(`📊 PRICE MATCH: ${marketKey} using cached prices UP=$${foundMarket.currentPriceUp.toFixed(4)} DOWN=$${foundMarket.currentPriceDown.toFixed(4)}`);
                } else {
                    // Fallback: Try to fetch from API
                    const assetUpId = foundMarket?.assetUp;
                    const assetDownId = foundMarket?.assetDown;
                    const conditionId = activity.conditionId || '';
                    const fetchedPrices = await this.fetchMarketPrices(conditionId, assetUpId, assetDownId);

                    // Use fetched prices if valid (not default 0.5/0.5)
                    if (fetchedPrices.priceUp !== 0.5 || fetchedPrices.priceDown !== 0.5) {
                        prices = fetchedPrices;
                        console.log(`📊 PRICE FETCH: Using API prices UP=$${fetchedPrices.priceUp.toFixed(4)} DOWN=$${fetchedPrices.priceDown.toFixed(4)}`);
                    } else {
                        // Last resort: Use execution price for traded side, calculate other
                        console.log(`⚠️ PRICE FALLBACK: No cached/fetched prices found for ${activitySlug || activityConditionId}, using calculation`);
                        if (isUp) {
                            prices = {
                                priceUp: tradePrice,
                                priceDown: Math.max(0.01, 1.0 - tradePrice)
                            };
                        } else {
                            prices = {
                                priceUp: Math.max(0.01, 1.0 - tradePrice),
                                priceDown: tradePrice
                            };
                        }
                    }
                }
            }

            // Calculate price differences (execution price vs market price)
            // This shows the arbitrage spread we're capturing!
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

            // Get the market name for the CSV file
            const marketName = activity.title || activity.slug || 'Unknown';

            // Get or create the CSV file for this market
            const csvPath = this.getMarketCsvPath(marketName);

            // Append to the market-specific CSV file
            fs.appendFileSync(csvPath, row + '\n', 'utf8');
            this.loggedTrades.add(tradeKey);

            // Log to price stream with EXACT timestamp and TRUE API prices
            const marketTitle = activity.title || activity.slug || 'Unknown';
            const entryType = traderAddress === 'PAPER' ? 'PAPER' : 'WATCH';
            const entryNotes = `${outcome} ${size.toFixed(4)} shares @ $${tradePrice.toFixed(4)}`;

            // Use EXACT trade timestamp (convert from seconds to ms if needed)
            const tradeTimestampMs = timestamp; // Already in ms from line 382

            // For price stream: use the ACTUAL API prices (both UP and DOWN fetched from orderbook)
            // These are injected into the activity by tradeMonitor before calling logTrade
            // NO calculation - both prices come directly from the CLOB API
            const streamPriceUp = prices.priceUp;
            const streamPriceDown = prices.priceDown;

            // Validate prices are reasonable (skip if not)
            if (streamPriceUp <= 0 || streamPriceUp >= 1 || streamPriceDown <= 0 || streamPriceDown >= 1) {
                // Only log warnings in non-watcher mode (keeps dashboard clean)
                if (!ENV.TRACK_ONLY_MODE) {
                    console.log(`⚠️ Price stream entry skipped: invalid prices UP=$${streamPriceUp.toFixed(4)} DOWN=$${streamPriceDown.toFixed(4)}`);
                }
                return;
            }

            // Also validate that prices add up (sanity check)
            const priceSum = streamPriceUp + streamPriceDown;
            if (priceSum < 0.90 || priceSum > 1.10) {
                // Only log warnings in non-watcher mode
                if (!ENV.TRACK_ONLY_MODE) {
                    console.log(`⚠️ Price stream entry skipped: prices don't add up (UP=$${streamPriceUp.toFixed(4)} + DOWN=$${streamPriceDown.toFixed(4)} = $${priceSum.toFixed(4)})`);
                }
                return;
            }

            if (entryType === 'PAPER') {
                priceStreamLogger.markPaperEntry(
                    activity.slug || '',
                    marketTitle,
                    streamPriceUp,
                    streamPriceDown,
                    entryNotes,
                    activity.transactionHash,
                    tradeTimestampMs
                );
            } else {
                priceStreamLogger.markWatchEntry(
                    activity.slug || '',
                    marketTitle,
                    streamPriceUp,
                    streamPriceDown,
                    entryNotes,
                    activity.transactionHash,
                    tradeTimestampMs
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
