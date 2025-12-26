/**
 * Paper Trade Monitor - Expiration Arbitrage Strategy
 *
 * Strategy:
 * 1. DISCOVER markets from watched traders' activity (not our own API search)
 * 2. Split USDC into equal YES + NO positions (neutral, zero directional exposure)
 * 3. Wait until 1-2 minutes before expiration
 * 4. When outcome is clear (one side 95%+), buy the losing side for 1-2 cents
 * 5. If unclear (60/40, 70/30) - do nothing, let it expire, take collateral back
 * 6. Collect original collateral + ~1-2% gain per cycle
 *
 * No leverage, no liquidations, no guessing. Just math and structure.
 */

import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import marketTracker from './marketTracker';
import tradeLogger from './tradeLogger';

// Debug log file for paper mode (won't be cleared by screen refresh)
const debugLogPath = path.join(process.cwd(), 'logs', 'paper_debug.log');

function debugLog(message: string): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    try {
        fs.appendFileSync(debugLogPath, logLine);
    } catch (e) {
        // Ignore errors - debug logging shouldn't break the bot
    }
}

// =============================================================================
// CONFIGURATION - REVERSE ENGINEERED FROM 41,030 WATCHER TRADES
// =============================================================================
const PAPER_STARTING_CAPITAL = parseFloat(process.env.PAPER_STARTING_CAPITAL || '10000');

// Per-market allocation (from watcher: avg $2,378 per market, median $2,036)
// BTC gets more capital (28k trades vs 12k ETH trades)
const PAPER_BTC_MAX_PER_MARKET = parseFloat(process.env.PAPER_BTC_MAX_PER_MARKET || '2400');
const PAPER_ETH_MAX_PER_MARKET = parseFloat(process.env.PAPER_ETH_MAX_PER_MARKET || '1800');

// =============================================================================
// THE SECRET SAUCE: WATCHER SIZES BY SHARES, NOT VALUE!
// Dec 26 DATA: Paper 43.8% trades under $2 vs Watcher 31.1%
// Paper has too many tiny trades - reduce weights for 1,2 shares
// Top share amounts: 5(10.2%), 16(9.9%), 1(8.3%), 2(7.4%), 28(7.0%)
// =============================================================================
const TARGET_SHARE_AMOUNTS = [5, 16, 28, 1, 2, 14, 10, 3, 22, 15, 6, 4, 8, 12, 7];
// ADJUSTED: Boost 5, 16, 28 weights; reduce 1, 2 weights to cut tiny trades
const SHARE_WEIGHTS = [12.0, 11.0, 10.0, 5.0, 4.5, 5.5, 5.0, 4.0, 4.0, 4.0, 3.5, 3.5, 3.0, 3.0, 3.0];
// Minimum shares for a trade (watcher does 1-share trades too)
const MIN_SHARES = 0.5;

// =============================================================================
// TIMING PATTERNS (from Dec 26 analysis)
// Watcher: 78.1% of gaps are 2-5s! Paper was only 42.9%
// CRITICAL FIX: Increase fast trade percentage to match watcher
// =============================================================================
const BATCH_INTERVAL_MS = 2000;
const BASE_GAP_MS = 2500;
const POLL_INTERVAL_MS = 1000;

// Direction balance: 50.7% UP by $, 49.9% UP by count
const UP_BIAS = 0.507; // Match exact watcher ratio by $
const DIRECTION_VARIANCE = 0.02;

// =============================================================================
// DYNAMIC REBALANCING - THE REAL SECRET SAUCE
// Watcher chases momentum: when price moves up, he shifts allocation to UP
// This is DYNAMIC, not static - he adjusts minute-by-minute based on live prices
// =============================================================================
const MOMENTUM_CHASE_FACTOR = 0.6; // How aggressively to chase momentum (0-1)
const PRICE_THRESHOLD_FOR_CHASE = 0.10; // Min price move to trigger chase (10 cents)
const REBALANCE_CHECK_INTERVAL_MS = 10000; // Check rebalance every 10 seconds

// Arbitrage strategy parameters
const EXPIRATION_WINDOW_MS = 2 * 60 * 1000;
const CLEAR_OUTCOME_THRESHOLD = 0.95;
const MAX_LOSER_PRICE = 0.05;
const MIN_LOSER_PRICE = 0.001;
const SKIP_UNCLEAR_THRESHOLD = 0.70;

// Legacy (unused but kept for env var compatibility)
const PAPER_MIN_TRADE = parseFloat(process.env.PAPER_MIN_TRADE || '0.50');
const PAPER_MEDIAN_TRADE = parseFloat(process.env.PAPER_MEDIAN_TRADE || '6');
const PAPER_MAX_TRADE = parseFloat(process.env.PAPER_MAX_TRADE || '15');

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!USER_ADDRESSES || USER_ADDRESSES.length === 0) {
    throw new Error('USER_ADDRESSES is not defined or empty');
}

// Create activity models for each user
const userModels = USER_ADDRESSES.map((address) => ({
    address,
    UserActivity: getUserActivityModel(address),
}));

// Paper trading state
let isRunning = true;
let currentCapital = PAPER_STARTING_CAPITAL;
let totalPnL = 0;
let totalTrades = 0;
let totalCycles = 0;

// Track which condition IDs we've seen from watched traders
const discoveredConditionIds = new Set<string>();

// Track processed trades in memory
const processedTrades = new Set<string>();

interface MarketPosition {
    conditionId: string;
    marketKey: string;
    marketName: string;
    marketSlug: string;
    assetUp: string;
    assetDown: string;
    endDate: number; // Unix timestamp in ms

    // Initial split position (YES + NO)
    sharesUp: number;
    sharesDown: number;
    costUp: number;
    costDown: number;

    // Arbitrage position (buying the loser near expiration)
    arbSharesUp: number;
    arbSharesDown: number;
    arbCostUp: number;
    arbCostDown: number;

    // Current prices
    currentPriceUp: number;
    currentPriceDown: number;

    // Tracking
    hasSplitPosition: boolean;
    hasArbitragePosition: boolean;
    isSettled: boolean;
    settlementPnL: number;
    createdAt: number;
}

// Active positions by conditionId
const positions = new Map<string, MarketPosition>();

// Discovered markets from watched traders
const discoveredMarkets = new Map<string, {
    conditionId: string;
    marketKey: string;
    marketName: string;
    marketSlug: string;
    assetUp: string;
    assetDown: string;
    endDate: number;
    priceUp: number;
    priceDown: number;
    lastUpdate: number;
}>();

// Track processed market cycles to avoid double-trading
const processedCycles = new Set<string>();

// Track incremental position building state
interface PositionBuildState {
    marketKey: string;
    targetUp: number;      // Target USD allocation for UP
    targetDown: number;    // Target USD allocation for DOWN
    investedUp: number;    // Currently invested in UP
    investedDown: number;  // Currently invested in DOWN
    lastTradeTime: number; // Last trade timestamp
    nextTradeTime: number; // When next trade should happen (gap applied once after each trade)
    tradeCount: number;    // Number of trades executed
    avgPriceUp: number;    // Weighted average price for UP
    avgPriceDown: number;  // Weighted average price for DOWN
    // DYNAMIC REBALANCING - track price history for momentum detection
    initialPriceUp: number;    // Price when we started building
    initialPriceDown: number;
    lastRebalanceTime: number; // Last time we checked for rebalancing
    momentumBias: number;      // Current momentum bias (-1 to +1, positive = favoring UP)
}
const buildingPositions = new Map<string, PositionBuildState>();

/**
 * Fetch order book mid-price for an asset
 */
async function getOrderBookPrice(assetId: string): Promise<number | null> {
    try {
        const bookData = await fetchData(
            `https://clob.polymarket.com/book?token_id=${assetId}`
        ).catch(() => null);

        if (bookData?.bids?.length > 0 && bookData?.asks?.length > 0) {
            const bestBid = Math.max(...bookData.bids.map((b: any) => parseFloat(b.price || 0)));
            const bestAsk = Math.min(...bookData.asks.map((a: any) => parseFloat(a.price || 1)));

            if (bestBid > 0 && bestAsk > 0 && bestBid <= 1 && bestAsk <= 1) {
                return (bestBid + bestAsk) / 2;
            }
        }
    } catch (e) {
        // Silent fail
    }
    return null;
}

/**
 * Fetch market expiration time from Gamma API using conditionId
 */
async function fetchMarketExpiration(conditionId: string): Promise<number | null> {
    if (!conditionId) {
        return null;
    }

    try {
        // Fetch from Gamma API - it has more reliable expiration data
        const gammaUrl = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500`;
        const marketList = await fetchData(gammaUrl).catch(() => null);

        if (Array.isArray(marketList)) {
            const marketData = marketList.find((m: any) => m.condition_id === conditionId);
            if (marketData) {
                // Gamma API provides end_date_iso or endDate in various formats
                if (marketData.end_date_iso) {
                    const endDate = new Date(marketData.end_date_iso).getTime();
                    if (endDate > 0) {
                        return endDate;
                    }
                }
                if (marketData.endDate) {
                    // If it's a timestamp, check if it's in seconds or milliseconds
                    const endDate = typeof marketData.endDate === 'number' 
                        ? (marketData.endDate < 10000000000 ? marketData.endDate * 1000 : marketData.endDate)
                        : new Date(marketData.endDate).getTime();
                    if (endDate > 0) {
                        return endDate;
                    }
                }
                if (marketData.end_time) {
                    const endDate = typeof marketData.end_time === 'number'
                        ? (marketData.end_time < 10000000000 ? marketData.end_time * 1000 : marketData.end_time)
                        : new Date(marketData.end_time).getTime();
                    if (endDate > 0) {
                        return endDate;
                    }
                }
            }
        }
    } catch (e) {
        // Silent fail - don't break the bot if API call fails
        debugLog(`fetchMarketExpiration failed for ${conditionId}: ${e}`);
    }
    return null;
}

/**
 * Get market key from title
 */
function getMarketKey(title: string): string {
    const lowerTitle = title.toLowerCase();

    const isBTC = lowerTitle.includes('bitcoin') || lowerTitle.includes('btc');
    const isETH = lowerTitle.includes('ethereum') || lowerTitle.includes('eth');
    const is15Min = lowerTitle.includes('15') || /\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/i.test(title);
    const isHourly = /\d{1,2}\s*(?:am|pm)\s*et/i.test(lowerTitle) && !is15Min;

    if (isBTC) {
        return is15Min ? 'BTC-UpDown-15' : (isHourly ? 'BTC-UpDown-1h' : 'BTC-UpDown');
    } else if (isETH) {
        return is15Min ? 'ETH-UpDown-15' : (isHourly ? 'ETH-UpDown-1h' : 'ETH-UpDown');
    }

    return 'Other';
}

/**
 * Discover markets from watched traders' activity
 * Uses the SAME logic as watcher mode - passes activity to marketTracker
 */
async function discoverMarketsFromWatchers(): Promise<void> {
    const now = Date.now();
    const cutoffSeconds = Math.floor(now / 1000) - (48 * 60 * 60); // Last 48 hours
    const recentCutoffSeconds = Math.floor(now / 1000) - (5 * 60); // Last 5 minutes

    for (const { address } of userModels) {
        try {
            // Same API call as watcher mode
            const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE&limit=200`;
            const activities = await fetchData(apiUrl);

            if (!Array.isArray(activities)) continue;

            for (const activity of activities) {
                const isRecent = activity.timestamp >= recentCutoffSeconds;
                const isWithinWindow = activity.timestamp >= cutoffSeconds;

                if (!isRecent && !isWithinWindow) continue;

                // Verify trade belongs to watched wallet (same as watcher mode)
                if (activity.proxyWallet && activity.proxyWallet.toLowerCase() !== address.toLowerCase()) {
                    continue;
                }
                if (activity.user && activity.user.toLowerCase() !== address.toLowerCase()) {
                    continue;
                }

                const tradeKey = `${address}:${activity.transactionHash}`;
                if (processedTrades.has(tradeKey)) continue;
                processedTrades.add(tradeKey);

                // In PAPER mode, we DON'T pass watcher trades to marketTracker.processTrade()
                // because that would pollute the paper stats with watcher trade data.
                // Instead, we only use watcher trades for MARKET DISCOVERY (getting conditionId, assets, endDate)
                // Paper trades are added separately via logPaperTrade() which calls marketTracker.processTrade()

                // Extract market info for discovery without adding to marketTracker stats
                const beforeCount = discoveredMarkets.size;

                // Parse the activity to get market info for discovery
                const title = activity.title || activity.slug || '';
                const isUp = title.toLowerCase().includes(' up');
                const assetId = activity.asset || '';
                const conditionId = activity.conditionId || '';

                // Only discover new markets, don't track positions
                if (conditionId && !discoveredMarkets.has(conditionId)) {
                    // This is a new market - we'll discover it in the sync below
                    debugLog(`WATCHER TRADE: New market discovered via watcher: ${title}`);
                }

                // Still need marketTracker to parse and validate the market
                // but position tracking is disabled in PAPER mode (see marketTracker.processTrade check)
                const beforeMarketCount = marketTracker.getMarkets().size;
                await marketTracker.processTrade(activity).catch((err) => {
                    debugLog(`Error processing trade for discovery: ${err}`);
                });
                const afterMarketCount = marketTracker.getMarkets().size;
                if (afterMarketCount > beforeMarketCount) {
                    debugLog(`marketTracker discovered new market! Now has ${afterMarketCount} markets`);
                    debugLog(`Trade: ${title}`);
                }
            }
        } catch (error) {
            Logger.error(`Error fetching activity for ${address.slice(0, 6)}...${address.slice(-4)}: ${error}`);
        }
    }

    // Now sync discovered markets FROM marketTracker
    // This gets all markets that marketTracker has discovered and validated
    const trackerMarkets = marketTracker.getMarkets();

    // Log every time we check for markets (for debugging)
    debugLog(`discoverMarketsFromWatchers: trackerMarkets.size=${trackerMarkets.size}, discoveredMarkets.size=${discoveredMarkets.size}`);

    if (trackerMarkets.size > 0 && discoveredMarkets.size === 0) {
        debugLog(`marketTracker has ${trackerMarkets.size} markets, syncing to discoveredMarkets...`);
        for (const [key, m] of trackerMarkets.entries()) {
            debugLog(`   - ${key}: conditionId=${m.conditionId || 'none'}, endDate=${m.endDate ? new Date(m.endDate).toISOString() : 'none'}, assetUp=${m.assetUp ? 'yes' : 'no'}, assetDown=${m.assetDown ? 'yes' : 'no'}`);
        }
    }

    for (const [marketKey, market] of trackerMarkets.entries()) {
        // Use marketKey as the ID since conditionId may not always be set
        const id = market.conditionId || marketKey;

        // Skip expired markets (but be lenient - only skip if expired by more than 1 minute)
        // Also skip check if endDate is not set (0 or undefined) - we'll still track these
        if (market.endDate && market.endDate > 0 && market.endDate < now - 60000) {
            debugLog(`Skipping expired market: ${marketKey} (ended ${new Date(market.endDate).toISOString()})`);
            continue;
        }

        const existing = discoveredMarkets.get(id);

        if (existing) {
            // Update with latest info from marketTracker
            if (market.assetUp) existing.assetUp = market.assetUp;
            if (market.assetDown) existing.assetDown = market.assetDown;
            if (market.currentPriceUp) existing.priceUp = market.currentPriceUp;
            if (market.currentPriceDown) existing.priceDown = market.currentPriceDown;
            if (market.endDate) existing.endDate = market.endDate;
            existing.lastUpdate = now;
            
            // If endDate is missing or 0, try to fetch from Gamma API
            if ((!existing.endDate || existing.endDate === 0) && market.conditionId) {
                const fetchedEndDate = await fetchMarketExpiration(market.conditionId);
                if (fetchedEndDate) {
                    existing.endDate = fetchedEndDate;
                    debugLog(`Updated endDate for ${existing.marketKey} from Gamma API: ${new Date(fetchedEndDate).toISOString()}`);
                }
            }
        } else {
            // New market from marketTracker
            let endDate = market.endDate || 0;
            
            // If endDate is missing, try to fetch from Gamma API
            if ((!endDate || endDate === 0) && market.conditionId) {
                const fetchedEndDate = await fetchMarketExpiration(market.conditionId);
                if (fetchedEndDate) {
                    endDate = fetchedEndDate;
                    debugLog(`Fetched endDate for ${market.marketKey} from Gamma API: ${new Date(fetchedEndDate).toISOString()}`);
                }
            }
            
            const newMarket = {
                conditionId: id,
                marketKey: market.marketKey,
                marketName: market.marketName,
                marketSlug: market.marketSlug || '',
                assetUp: market.assetUp || '',
                assetDown: market.assetDown || '',
                endDate: endDate,
                priceUp: market.currentPriceUp || 0.5,
                priceDown: market.currentPriceDown || 0.5,
                lastUpdate: now,
            };
            discoveredMarkets.set(id, newMarket);

            // Calculate time remaining - handle both seconds and milliseconds
            let timeLeftMin = 0;
            if (newMarket.endDate && newMarket.endDate > 0) {
                // If endDate is less than 10000000000, it's likely in seconds, convert to ms
                const endDateMs = newMarket.endDate < 10000000000 ? newMarket.endDate * 1000 : newMarket.endDate;
                const timeDiff = endDateMs - now;
                timeLeftMin = Math.max(0, Math.floor(timeDiff / 60000)); // Ensure non-negative
            }

            debugLog(`✅ NEW MARKET DISCOVERED: ${market.marketKey}`);
            debugLog(`   ID: ${id}, assetUp: ${newMarket.assetUp || 'none'}, assetDown: ${newMarket.assetDown || 'none'}, endDate: ${newMarket.endDate ? new Date(newMarket.endDate).toISOString() : 'none'}`);

            // Log prominently when we find a new market
            Logger.success(`🎯 NEW MARKET DISCOVERED: ${market.marketKey} | ${timeLeftMin}m remaining | UP:${newMarket.assetUp ? '✓' : '✗'} DOWN:${newMarket.assetDown ? '✓' : '✗'}`);
        }
    }

    // Clean up markets that are no longer in trackerMarkets
    // This removes old conditionIds when markets rotate
    const trackerIds = new Set<string>();
    for (const [marketKey, market] of trackerMarkets.entries()) {
        trackerIds.add(market.conditionId || marketKey);
    }

    for (const [conditionId, market] of discoveredMarkets.entries()) {
        // Remove if expired
        if (market.endDate && market.endDate < now - 60000) {
            debugLog(`Removing expired market from discoveredMarkets: ${market.marketKey} (${conditionId})`);
            discoveredMarkets.delete(conditionId);
            continue;
        }
        // Remove if no longer in trackerMarkets (market rotated)
        // BUT only if it's not a proactively discovered market
        if (!trackerIds.has(conditionId) && !proactivelyDiscoveredIds.has(conditionId)) {
            debugLog(`Removing stale market from discoveredMarkets: ${market.marketKey} (${conditionId}) - not in trackerMarkets`);
            discoveredMarkets.delete(conditionId);
        }
    }
}

// Track proactively discovered market IDs (so they don't get cleaned up by tracker sync)
const proactivelyDiscoveredIds = new Set<string>();

/**
 * Clean up expired markets and positions to prepare for new ones
 * NOTE: The 15-minute BTC/ETH up/down markets are NOT listed on standard Polymarket APIs.
 * They can only be discovered when the watcher trades on them.
 * This function cleans up expired markets so we're ready when new ones appear.
 */
async function cleanupExpiredMarketsAndPositions(): Promise<void> {
    const now = Date.now();
    const EXPIRED_THRESHOLD_MS = 60000; // 1 minute past expiration

    // Clean up expired positions (those that are settled or past expiration)
    for (const [conditionId, position] of positions.entries()) {
        if (position.isSettled) continue;

        const market = discoveredMarkets.get(conditionId);

        // Remove if market no longer exists in discoveredMarkets (orphaned position)
        if (!market) {
            debugLog(`CLEANUP: Removing orphaned position for ${position.marketKey} (market no longer tracked)`);
            // Reclaim capital (assume position returned investment)
            currentCapital += position.costUp + position.costDown;
            positions.delete(conditionId);
            continue;
        }

        // Only clean up if endDate is set AND has passed by more than 1 minute
        if (position.endDate && position.endDate > 0 && position.endDate < now - EXPIRED_THRESHOLD_MS) {
            debugLog(`CLEANUP: Removing expired position for ${position.marketKey} (ended ${new Date(position.endDate).toISOString()})`);
            // Reclaim capital
            currentCapital += position.costUp + position.costDown;
            positions.delete(conditionId);
        }
    }

    // Clean up expired building positions
    for (const [conditionId, buildState] of buildingPositions.entries()) {
        const market = discoveredMarkets.get(conditionId);

        // Remove if market no longer exists in discoveredMarkets (orphaned position)
        if (!market) {
            debugLog(`CLEANUP: Removing orphaned building position for ${buildState.marketKey} (market no longer tracked)`);
            // Reclaim capital that was "reserved" for this position
            currentCapital += buildState.investedUp + buildState.investedDown;
            buildingPositions.delete(conditionId);
            continue;
        }

        // Remove if market has expired
        if (market.endDate && market.endDate > 0 && market.endDate < now - EXPIRED_THRESHOLD_MS) {
            debugLog(`CLEANUP: Removing expired building position for ${buildState.marketKey}`);
            // Reclaim capital - assume we made our money back at settlement
            currentCapital += buildState.investedUp + buildState.investedDown;
            buildingPositions.delete(conditionId);
        }
    }

    // Clean up expired discovered markets
    for (const [conditionId, market] of discoveredMarkets.entries()) {
        if (market.endDate && market.endDate < now - EXPIRED_THRESHOLD_MS) {
            debugLog(`CLEANUP: Removing expired market ${market.marketKey} (${conditionId})`);
            discoveredMarkets.delete(conditionId);
            proactivelyDiscoveredIds.delete(conditionId);
        }
    }

    // Log current state
    const activeMarkets = Array.from(discoveredMarkets.values()).filter(m => !m.endDate || m.endDate > now);
    const activePositions = Array.from(positions.values()).filter(p => !p.isSettled);

    debugLog(`CLEANUP: Done. Markets: ${discoveredMarkets.size}, BuildingPos: ${buildingPositions.size}, Positions: ${positions.size}, Capital: $${currentCapital.toFixed(2)}`);

    if (activeMarkets.length === 0 && activePositions.length === 0) {
        debugLog(`CLEANUP: No active markets or positions. Waiting for watcher to trade on new 15-min markets...`);
    }
}

// NOTE: The 15-minute BTC/ETH up/down markets are NOT available via standard Polymarket APIs.
// They can only be discovered by monitoring the watcher's trading activity.
// The processProactiveMarket function has been removed as it was non-functional.

/**
 * Update prices for all discovered markets
 */
async function updatePrices(): Promise<void> {
    const now = Date.now();

    // Filter markets that have both assets and are not expired
    // If endDate is 0/undefined, we still update prices
    const marketsToUpdate = Array.from(discoveredMarkets.values())
        .filter(m => m.assetUp && m.assetDown && (!m.endDate || m.endDate > now));

    // Update in parallel batches
    const batchSize = 5;
    for (let i = 0; i < marketsToUpdate.length; i += batchSize) {
        const batch = marketsToUpdate.slice(i, i + batchSize);
        await Promise.all(batch.map(async (market) => {
            const [priceUp, priceDown] = await Promise.all([
                getOrderBookPrice(market.assetUp),
                getOrderBookPrice(market.assetDown)
            ]);

            if (priceUp !== null) market.priceUp = priceUp;
            if (priceDown !== null) market.priceDown = priceDown;
            market.lastUpdate = now;

            // Also update position prices if we have one
            const position = positions.get(market.conditionId);
            if (position) {
                if (priceUp !== null) position.currentPriceUp = priceUp;
                if (priceDown !== null) position.currentPriceDown = priceDown;
            }
        }));
    }
}

/**
 * Build position incrementally with many small trades (like watcher does)
 * This achieves better cost averaging than one big trade
 */
async function buildPositionIncrementally(market: typeof discoveredMarkets extends Map<string, infer V> ? V : never): Promise<void> {
    // Use conditionId as position key to distinguish between different market instances
    // (e.g., different 15-min markets have different conditionIds)
    const positionKey = market.conditionId;
    const now = Date.now();

    // Skip if we don't have both assets
    if (!market.assetUp || !market.assetDown) {
        if (!discoveredConditionIds.has(`skip-assets-${positionKey}`)) {
            discoveredConditionIds.add(`skip-assets-${positionKey}`);
            debugLog(`buildPosition: ${market.marketKey} - missing assets`);
        }
        return;
    }

    // Skip if no valid prices
    if (!market.priceUp || !market.priceDown || market.priceUp <= 0 || market.priceDown <= 0) {
        return;
    }

    // Check time to expiration - stop building 2 min before expiration
    if (market.endDate && market.endDate > 0) {
        // If endDate is less than 10000000000, it's likely in seconds, convert to ms
        const endDateMs = market.endDate < 10000000000 ? market.endDate * 1000 : market.endDate;
        const timeToExpiration = endDateMs - now;
        if (timeToExpiration < EXPIRATION_WINDOW_MS) {
            // Position building complete, finalize if we have any investment
            const buildState = buildingPositions.get(positionKey);
            if (buildState && buildState.investedUp > 0 && buildState.investedDown > 0 && !positions.has(positionKey)) {
                await finalizePosition(market, buildState);
            }
            return;
        }
    }

    // Get or create building state
    let buildState = buildingPositions.get(positionKey);

    if (!buildState) {
        // =======================================================================
        // POSITION INITIALIZATION - Matches watcher's per-market allocation
        // NEW DATA: avg $2,398/market, median $1,961
        // Paper was only $895 - need to increase significantly
        // =======================================================================
        const isBTC = market.marketKey.includes('BTC');
        const maxPerMarket = isBTC ? PAPER_BTC_MAX_PER_MARKET : PAPER_ETH_MAX_PER_MARKET;

        // Dec 26 DATA: Paper $774/market vs Watcher $2,324/market
        // CRITICAL FIX: Increase from 50% to 70% of capital per market
        // Watcher invests ~$2000-2400 per market with ~400 trades/market
        const positionSize = Math.min(maxPerMarket, currentCapital * 0.70);

        if (positionSize < 10) { // Minimum $10 per position
            return;
        }

        // WATCHER PATTERN: 50.7% UP by $, 49.9% UP by trade count
        const sessionVariance = (Math.random() - 0.5) * 2 * DIRECTION_VARIANCE;
        const upRatio = Math.max(0.49, Math.min(0.52, UP_BIAS + sessionVariance));
        const downRatio = 1 - upRatio;

        buildState = {
            marketKey: market.marketKey,
            targetUp: positionSize * upRatio,
            targetDown: positionSize * downRatio,
            investedUp: 0,
            investedDown: 0,
            lastTradeTime: 0,
            nextTradeTime: now, // Trade immediately on first iteration
            tradeCount: 0,
            avgPriceUp: 0,
            avgPriceDown: 0,
            // DYNAMIC REBALANCING - capture initial prices for momentum tracking
            initialPriceUp: market.priceUp,
            initialPriceDown: market.priceDown,
            lastRebalanceTime: now,
            momentumBias: 0, // Start neutral
        };
        buildingPositions.set(positionKey, buildState);

        debugLog(`buildPosition: STARTED building ${market.marketKey} - target UP: $${buildState.targetUp.toFixed(2)}, DOWN: $${buildState.targetDown.toFixed(2)}`);
        Logger.info(`📈 Building position: ${market.marketKey} | Target: UP $${buildState.targetUp.toFixed(2)} / DOWN $${buildState.targetDown.toFixed(2)}`);
    }

    // ==========================================================================
    // TIMING PATTERN (from watcher analysis)
    // Gap between batches: 42% are 2-5s, 28% are 5-10s, 17% are 10-20s
    // nextTradeTime is set AFTER each trade to ensure consistent gaps
    // ==========================================================================
    if (now < buildState.nextTradeTime) {
        return; // Wait until next trade time
    }

    // Check if position is complete
    const upComplete = buildState.investedUp >= buildState.targetUp * 0.98;
    const downComplete = buildState.investedDown >= buildState.targetDown * 0.98;

    // Keep trading like the watcher - continuous until market ends
    if (upComplete && downComplete) {
        buildState.targetUp *= 1.1;
        buildState.targetDown *= 1.1;
        debugLog(`buildPosition: ${market.marketKey} targets increased to UP:$${buildState.targetUp.toFixed(2)} DOWN:$${buildState.targetDown.toFixed(2)}`);
    }

    // ==========================================================================
    // THE SECRET SAUCE: SIZE BY SHARES, NOT VALUE!
    // Watcher selects from specific share amounts: 5, 28, 16, 2, 1, 14, 10...
    // Value = shares × price (so value naturally varies with price)
    // ==========================================================================
    function selectTargetShares(): number {
        // Weighted random selection from watcher's most common share amounts
        const totalWeight = SHARE_WEIGHTS.reduce((a, b) => a + b, 0);
        let rand = Math.random() * totalWeight;
        for (let i = 0; i < TARGET_SHARE_AMOUNTS.length; i++) {
            rand -= SHARE_WEIGHTS[i];
            if (rand <= 0) {
                // Add small variance (±10%) to avoid exact matches
                const variance = 0.9 + Math.random() * 0.2;
                return TARGET_SHARE_AMOUNTS[i] * variance;
            }
        }
        return 12; // Default fallback (median)
    }

    // ==========================================================================
    // DYNAMIC REBALANCING - Check for momentum and adjust bias
    // Watcher CHASES momentum: when UP price rises, he shifts allocation to UP
    // This is the real secret sauce - not static 50/50, but dynamic adjustment!
    // ==========================================================================
    if (now - buildState.lastRebalanceTime >= REBALANCE_CHECK_INTERVAL_MS) {
        const priceChangeUp = market.priceUp - buildState.initialPriceUp;
        const priceChangeDown = market.priceDown - buildState.initialPriceDown;

        // Calculate momentum: positive = UP is winning, negative = DOWN is winning
        // Watcher shifts 60% of allocation to winning side when price moves 10+ cents
        if (Math.abs(priceChangeUp) >= PRICE_THRESHOLD_FOR_CHASE) {
            // UP price moved significantly
            if (priceChangeUp > 0) {
                // UP is winning - shift bias toward UP (chase momentum)
                buildState.momentumBias = Math.min(1, priceChangeUp * MOMENTUM_CHASE_FACTOR * 2);
                debugLog(`MOMENTUM: ${market.marketKey} UP winning (+${priceChangeUp.toFixed(3)}) → bias ${buildState.momentumBias.toFixed(2)}`);
            } else {
                // UP price dropped = DOWN is winning - shift bias toward DOWN
                buildState.momentumBias = Math.max(-1, priceChangeUp * MOMENTUM_CHASE_FACTOR * 2);
                debugLog(`MOMENTUM: ${market.marketKey} DOWN winning (UP ${priceChangeUp.toFixed(3)}) → bias ${buildState.momentumBias.toFixed(2)}`);
            }
        }
        buildState.lastRebalanceTime = now;
    }

    // ==========================================================================
    // BATCH PATTERN: 32% trade both sides, 68% single side
    // When trading single side: balance UP/DOWN but CHASE MOMENTUM
    // ==========================================================================
    const upProgress = buildState.investedUp / buildState.targetUp;
    const downProgress = buildState.investedDown / buildState.targetDown;

    let sharesUp = 0;
    let sharesDown = 0;
    let tradeUp = 0;
    let tradeDown = 0;

    const tradeBothSides = Math.random() < 0.32; // 32% chance like watcher

    if (!upComplete && !downComplete) {
        if (tradeBothSides) {
            // Trade BOTH sides in same batch
            // But WEIGHT the sides based on momentum!
            sharesUp = selectTargetShares();
            sharesDown = selectTargetShares();

            // Apply momentum bias to shares (not value)
            // Positive bias = more UP shares, negative = more DOWN shares
            if (buildState.momentumBias > 0.1) {
                // Chasing UP - increase UP shares, decrease DOWN shares
                sharesUp *= (1 + buildState.momentumBias * 0.3);
                sharesDown *= (1 - buildState.momentumBias * 0.2);
            } else if (buildState.momentumBias < -0.1) {
                // Chasing DOWN - increase DOWN shares, decrease UP shares
                sharesDown *= (1 + Math.abs(buildState.momentumBias) * 0.3);
                sharesUp *= (1 - Math.abs(buildState.momentumBias) * 0.2);
            }

            tradeUp = sharesUp * market.priceUp;
            tradeDown = sharesDown * market.priceDown;
        } else {
            // Trade single side - MOMENTUM-WEIGHTED direction choice
            // Watcher chases the winning side more often
            let preferUp: boolean;

            // Base probability starts at 50%
            let upProbability = 0.50;

            // Adjust by momentum bias (up to ±20% swing)
            upProbability += buildState.momentumBias * 0.20;

            // Also consider progress (catch up if behind)
            if (Math.abs(upProgress - downProgress) >= 0.05) {
                // If significantly behind on one side, increase its probability
                if (upProgress < downProgress) {
                    upProbability += 0.10; // Favor UP to catch up
                } else {
                    upProbability -= 0.10; // Favor DOWN to catch up
                }
            }

            // Clamp probability
            upProbability = Math.max(0.30, Math.min(0.70, upProbability));
            preferUp = Math.random() < upProbability;

            if (preferUp) {
                sharesUp = selectTargetShares();
                tradeUp = sharesUp * market.priceUp;
            } else {
                sharesDown = selectTargetShares();
                tradeDown = sharesDown * market.priceDown;
            }
        }
    } else if (!upComplete) {
        sharesUp = selectTargetShares();
        tradeUp = sharesUp * market.priceUp;
    } else if (!downComplete) {
        sharesDown = selectTargetShares();
        tradeDown = sharesDown * market.priceDown;
    }

    // Cap trades to remaining targets and available capital
    const remainingUp = buildState.targetUp - buildState.investedUp;
    const remainingDown = buildState.targetDown - buildState.investedDown;

    if (tradeUp > remainingUp) {
        tradeUp = remainingUp;
        sharesUp = tradeUp / market.priceUp;
    }
    if (tradeDown > remainingDown) {
        tradeDown = remainingDown;
        sharesDown = tradeDown / market.priceDown;
    }

    // Capital check
    if (tradeUp + tradeDown > currentCapital) {
        // Scale down proportionally
        const scale = currentCapital / (tradeUp + tradeDown);
        tradeUp *= scale;
        tradeDown *= scale;
        sharesUp = tradeUp / market.priceUp;
        sharesDown = tradeDown / market.priceDown;
    }

    // Execute UP trade (minimum 0.5 shares like watcher)
    if (sharesUp >= MIN_SHARES && tradeUp > 0 && currentCapital >= tradeUp) {

        // Update weighted average price
        const totalInvestedUp = buildState.investedUp + tradeUp;
        buildState.avgPriceUp = (buildState.avgPriceUp * buildState.investedUp + market.priceUp * tradeUp) / totalInvestedUp;

        buildState.investedUp = totalInvestedUp;
        currentCapital -= tradeUp;
        buildState.tradeCount++;
        totalTrades++;

        // Create temporary position for logging
        const tempPos: MarketPosition = {
            conditionId: positionKey,
            marketKey: market.marketKey,
            marketName: market.marketName,
            marketSlug: market.marketSlug,
            assetUp: market.assetUp,
            assetDown: market.assetDown,
            endDate: market.endDate,
            sharesUp: 0, sharesDown: 0, costUp: 0, costDown: 0,
            arbSharesUp: 0, arbSharesDown: 0, arbCostUp: 0, arbCostDown: 0,
            currentPriceUp: market.priceUp, currentPriceDown: market.priceDown,
            hasSplitPosition: false, hasArbitragePosition: false, isSettled: false, settlementPnL: 0,
            createdAt: now,
        };
        await logPaperTrade(tempPos, 'UP', 'BUY', sharesUp, tradeUp, market.priceUp);

        debugLog(`buildPosition: ${market.marketKey} UP trade #${buildState.tradeCount}: ${sharesUp.toFixed(1)} shares @ ${market.priceUp.toFixed(4)} = $${tradeUp.toFixed(2)}`);
    }

    // Execute DOWN trade (minimum 0.5 shares like watcher)
    if (sharesDown >= MIN_SHARES && tradeDown > 0 && currentCapital >= tradeDown) {
        // Update weighted average price
        const totalInvestedDown = buildState.investedDown + tradeDown;
        buildState.avgPriceDown = (buildState.avgPriceDown * buildState.investedDown + market.priceDown * tradeDown) / totalInvestedDown;

        buildState.investedDown = totalInvestedDown;
        currentCapital -= tradeDown;
        buildState.tradeCount++;
        totalTrades++;

        const tempPos: MarketPosition = {
            conditionId: positionKey,
            marketKey: market.marketKey,
            marketName: market.marketName,
            marketSlug: market.marketSlug,
            assetUp: market.assetUp,
            assetDown: market.assetDown,
            endDate: market.endDate,
            sharesUp: 0, sharesDown: 0, costUp: 0, costDown: 0,
            arbSharesUp: 0, arbSharesDown: 0, arbCostUp: 0, arbCostDown: 0,
            currentPriceUp: market.priceUp, currentPriceDown: market.priceDown,
            hasSplitPosition: false, hasArbitragePosition: false, isSettled: false, settlementPnL: 0,
            createdAt: now,
        };
        await logPaperTrade(tempPos, 'DOWN', 'BUY', sharesDown, tradeDown, market.priceDown);

        debugLog(`buildPosition: ${market.marketKey} DOWN trade #${buildState.tradeCount}: ${sharesDown.toFixed(1)} shares @ ${market.priceDown.toFixed(4)} = $${tradeDown.toFixed(2)}`);
    }

    // Set next trade time based on watcher gap distribution
    // Dec 26 DATA: Watcher 78.1% are 2-5s, Paper was only 42.9%
    // CRITICAL FIX: Increase fast trade percentage to 80%
    const gapRoll = Math.random();
    let gap: number;
    if (gapRoll < 0.80) {
        gap = 2000 + Math.random() * 3000; // 2-5s (80% - matches watcher's 78%)
    } else if (gapRoll < 0.88) {
        gap = 5000 + Math.random() * 5000; // 5-10s (8%)
    } else if (gapRoll < 0.94) {
        gap = 10000 + Math.random() * 10000; // 10-20s (6%)
    } else {
        gap = 20000 + Math.random() * 40000; // 20-60s (6%)
    }

    buildState.lastTradeTime = now;
    buildState.nextTradeTime = now + gap;
}

/**
 * Finalize a position that was built incrementally
 */
async function finalizePosition(market: typeof discoveredMarkets extends Map<string, infer V> ? V : never, buildState: PositionBuildState): Promise<void> {
    // Use conditionId as position key (consistent with buildPositionIncrementally)
    const positionKey = market.conditionId;
    const now = Date.now();

    // Calculate shares from invested amounts and average prices
    const sharesUp = buildState.avgPriceUp > 0 ? buildState.investedUp / buildState.avgPriceUp : 0;
    const sharesDown = buildState.avgPriceDown > 0 ? buildState.investedDown / buildState.avgPriceDown : 0;

    const position: MarketPosition = {
        conditionId: positionKey,
        marketKey: market.marketKey,
        marketName: market.marketName,
        marketSlug: market.marketSlug,
        assetUp: market.assetUp,
        assetDown: market.assetDown,
        endDate: market.endDate,
        sharesUp,
        sharesDown,
        costUp: buildState.investedUp,
        costDown: buildState.investedDown,
        arbSharesUp: 0,
        arbSharesDown: 0,
        arbCostUp: 0,
        arbCostDown: 0,
        currentPriceUp: market.priceUp,
        currentPriceDown: market.priceDown,
        hasSplitPosition: true,
        hasArbitragePosition: false,
        isSettled: false,
        settlementPnL: 0,
        createdAt: now,
    };

    positions.set(positionKey, position);

    const totalInvested = buildState.investedUp + buildState.investedDown;
    const upPct = (buildState.investedUp / totalInvested * 100).toFixed(1);
    const downPct = (buildState.investedDown / totalInvested * 100).toFixed(1);

    debugLog(`finalizePosition: ${market.marketKey} - ${buildState.tradeCount} trades, avgUp: ${buildState.avgPriceUp.toFixed(4)}, avgDown: ${buildState.avgPriceDown.toFixed(4)}`);
    Logger.success(`📊 POSITION BUILT: ${market.marketKey} | ${buildState.tradeCount} trades | UP $${buildState.investedUp.toFixed(2)} @ avg ${buildState.avgPriceUp.toFixed(4)} / DOWN $${buildState.investedDown.toFixed(2)} @ avg ${buildState.avgPriceDown.toFixed(4)} (${upPct}/${downPct})`);

    // Clean up build state
    buildingPositions.delete(positionKey);
}

/**
 * Execute arbitrage trade - buy the losing side near expiration
 */
async function executeArbitrageTrade(position: MarketPosition, market: typeof discoveredMarkets extends Map<string, infer V> ? V : never): Promise<void> {
    if (position.hasArbitragePosition || position.isSettled) return;

    const now = Date.now();
    // If endDate is less than 10000000000, it's likely in seconds, convert to ms
    const endDateMs = position.endDate < 10000000000 ? position.endDate * 1000 : position.endDate;
    const timeToExpiration = endDateMs - now;

    // Only trade within the expiration window (1-2 min before end)
    if (timeToExpiration > EXPIRATION_WINDOW_MS || timeToExpiration < 10000) return;

    const priceUp = market.priceUp;
    const priceDown = market.priceDown;

    // Identify clear winner and cheap loser
    let winner: 'UP' | 'DOWN' | null = null;
    let loserPrice = 0;

    if (priceUp >= CLEAR_OUTCOME_THRESHOLD && priceDown <= MAX_LOSER_PRICE && priceDown >= MIN_LOSER_PRICE) {
        winner = 'UP';
        loserPrice = priceDown;
    } else if (priceDown >= CLEAR_OUTCOME_THRESHOLD && priceUp <= MAX_LOSER_PRICE && priceUp >= MIN_LOSER_PRICE) {
        winner = 'DOWN';
        loserPrice = priceUp;
    }

    // If outcome not clear - DO NOTHING (this is key to the strategy)
    if (!winner) {
        // Silently skip unclear outcomes - this is expected behavior
        return;
    }

    // Create unique cycle key to prevent double-trading
    const cycleKey = `${position.conditionId}:${Math.floor(position.endDate / 60000)}`;
    if (processedCycles.has(cycleKey)) return;
    processedCycles.add(cycleKey);

    // Calculate arbitrage trade size
    const availableCapital = Math.min(currentCapital, PAPER_MAX_TRADE);
    if (availableCapital < PAPER_MIN_TRADE) return;

    const arbShares = availableCapital / loserPrice;
    const arbCost = availableCapital;

    // Deduct capital
    currentCapital -= arbCost;

    // Update position
    if (winner === 'UP') {
        // UP is winning, buy DOWN (the loser) - it's cheap but will pay $1 if UP actually loses
        position.arbSharesDown += arbShares;
        position.arbCostDown += arbCost;
    } else {
        // DOWN is winning, buy UP (the loser)
        position.arbSharesUp += arbShares;
        position.arbCostUp += arbCost;
    }

    position.hasArbitragePosition = true;
    totalTrades++;

    const loserSide = winner === 'UP' ? 'DOWN' : 'UP';
    await logPaperTrade(position, loserSide, 'BUY', arbShares, arbCost, loserPrice);

    Logger.success(`🎯 ARB: ${position.marketKey} | Bought ${loserSide} @ $${loserPrice.toFixed(4)} (${arbShares.toFixed(0)} shares for $${arbCost.toFixed(2)}) | Winner: ${winner} (${((winner === 'UP' ? priceUp : priceDown) * 100).toFixed(1)}%)`);
}

/**
 * Settle expired positions
 */
async function settlePositions(): Promise<void> {
    const now = Date.now();

    for (const [conditionId, position] of positions.entries()) {
        if (position.isSettled) continue;
        // Only settle if endDate is set AND has passed
        // Skip if endDate is 0/undefined (not set yet)
        if (!position.endDate || position.endDate === 0 || position.endDate > now) continue;

        // Get final prices
        const market = discoveredMarkets.get(conditionId);
        let priceUp = market?.priceUp ?? position.currentPriceUp;
        let priceDown = market?.priceDown ?? position.currentPriceDown;

        // Try to fetch final prices if we don't have them
        if (!priceUp || !priceDown) {
            const [fetchedUp, fetchedDown] = await Promise.all([
                getOrderBookPrice(position.assetUp),
                getOrderBookPrice(position.assetDown)
            ]);
            if (fetchedUp !== null) priceUp = fetchedUp;
            if (fetchedDown !== null) priceDown = fetchedDown;
        }

        // Determine winner
        const upWon = priceUp >= 0.95;
        const downWon = priceDown >= 0.95;

        await settlePosition(position, upWon, downWon);
    }

    // Clean up old processed cycles
    if (processedCycles.size > 1000) {
        const toDelete = Array.from(processedCycles).slice(0, processedCycles.size - 500);
        toDelete.forEach(key => processedCycles.delete(key));
    }
}

/**
 * Settle a single position
 */
async function settlePosition(position: MarketPosition, upWon: boolean, downWon: boolean): Promise<void> {
    if (position.isSettled) return;

    // Calculate total cost
    const totalCost = position.costUp + position.costDown + position.arbCostUp + position.arbCostDown;

    // Calculate final value
    // If UP won: UP shares worth $1, DOWN shares worth $0
    // If DOWN won: DOWN shares worth $1, UP shares worth $0
    let finalValue = 0;

    if (upWon) {
        finalValue = (position.sharesUp + position.arbSharesUp) * 1.0;
    } else if (downWon) {
        finalValue = (position.sharesDown + position.arbSharesDown) * 1.0;
    } else {
        // Unclear outcome - get collateral back (shouldn't happen if we skipped unclear)
        finalValue = totalCost;
    }

    const pnl = finalValue - totalCost;

    // Return value to capital
    currentCapital += finalValue;
    totalPnL += pnl;
    totalCycles++;

    position.isSettled = true;
    position.settlementPnL = pnl;

    const pnlSign = pnl >= 0 ? '+' : '';
    const pnlPercent = totalCost > 0 ? ((pnl / totalCost) * 100).toFixed(2) : '0.00';

    Logger.info(`💰 SETTLED: ${position.marketKey} | Winner: ${upWon ? 'UP' : (downWon ? 'DOWN' : 'UNCLEAR')} | Cost: $${totalCost.toFixed(2)} → Value: $${finalValue.toFixed(2)} | PnL: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPercent}%)`);
    debugLog(`SETTLED position: ${position.marketKey} (key: ${position.conditionId}), endDate was: ${position.endDate}`);

    // Trigger display update
    marketTracker.forceDisplayUpdate();

    // Remove settled position after a delay
    setTimeout(() => {
        debugLog(`DELETING position: ${position.conditionId}`);
        positions.delete(position.conditionId);
    }, 5000);
}

/**
 * Log a paper trade
 */
async function logPaperTrade(
    position: MarketPosition,
    side: 'UP' | 'DOWN',
    action: 'BUY' | 'SELL',
    shares: number,
    cost: number,
    price: number
): Promise<void> {
    const paperActivity = {
        transactionHash: `paper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Math.floor(Date.now() / 1000),
        conditionId: position.conditionId,
        type: 'TRADE',
        size: shares.toString(),
        usdcSize: cost.toString(),
        price: price.toString(),
        asset: side === 'UP' ? position.assetUp : position.assetDown,
        side: action,
        outcomeIndex: side === 'UP' ? 0 : 1,
        outcome: side,
        title: position.marketName,
        slug: position.marketSlug,
        eventSlug: position.marketSlug,
        endDate: Math.floor(position.endDate / 1000),
    };

    // Process through marketTracker for display
    await marketTracker.processTrade(paperActivity);

    // Log to CSV
    tradeLogger.logTrade(paperActivity, 'PAPER').catch(() => {});
}

/**
 * Display current status
 */
function displayStatus(): void {
    const now = Date.now();
    const activePositions = Array.from(positions.values()).filter(p => !p.isSettled);
    const withSplit = activePositions.filter(p => p.hasSplitPosition && !p.hasArbitragePosition);
    const withArb = activePositions.filter(p => p.hasArbitragePosition);

    // Calculate total invested
    let totalInvested = 0;
    for (const pos of activePositions) {
        totalInvested += pos.costUp + pos.costDown + pos.arbCostUp + pos.arbCostDown;
    }

    const portfolioValue = currentCapital + totalInvested;
    const overallPnL = portfolioValue - PAPER_STARTING_CAPITAL + totalPnL;
    const pnlPercent = (overallPnL / PAPER_STARTING_CAPITAL) * 100;

    // Also count building positions
    let buildingInvested = 0;
    for (const [_, buildState] of buildingPositions.entries()) {
        buildingInvested += buildState.investedUp + buildState.investedDown;
    }

    // Show paper bot's own status - use success for visibility
    console.log(`\n🤖 PAPER ARB: Capital $${currentCapital.toFixed(2)} | Building: ${buildingPositions.size} | Positions: ${activePositions.length} | Trades: ${totalTrades}`);

    // Filter out expired markets for display
    const activeMarkets = Array.from(discoveredMarkets.entries()).filter(
        ([_, m]) => !m.endDate || m.endDate > now
    );

    // Show discovered markets with their status
    if (activeMarkets.length === 0) {
        console.log(`   ⏳ Waiting for watcher to trade on new 15-min markets...`);
    }

    for (const [id, m] of activeMarkets) {
        const hasAssets = m.assetUp && m.assetDown;
        // Calculate time left - handle both seconds and milliseconds
        let timeLeft = 0;
        if (m.endDate && m.endDate > 0) {
            // If endDate is less than 10000000000, it's likely in seconds, convert to ms
            const endDateMs = m.endDate < 10000000000 ? m.endDate * 1000 : m.endDate;
            const timeDiff = endDateMs - now;
            timeLeft = Math.max(0, Math.floor(timeDiff / 60000)); // Ensure non-negative
        }
        // Use conditionId (id) to look up position and build state
        const hasPosition = positions.has(id);
        const buildState = buildingPositions.get(id);

        if (!hasAssets) {
            console.log(`   ⏳ ${m.marketKey}: Waiting for assets (UP:${m.assetUp ? '✓' : '✗'} DOWN:${m.assetDown ? '✓' : '✗'})`);
        } else if (buildState) {
            // Show building progress
            const upPct = ((buildState.investedUp / buildState.targetUp) * 100).toFixed(0);
            const downPct = ((buildState.investedDown / buildState.targetDown) * 100).toFixed(0);
            console.log(`   📈 ${m.marketKey}: BUILDING ${buildState.tradeCount} trades | UP ${upPct}% DOWN ${downPct}% | ${timeLeft}m left`);
        } else if (hasPosition) {
            const pos = positions.get(id)!;
            const status = pos.hasArbitragePosition ? '✅ARB' : '⏳WAIT';
            const totalInv = pos.costUp + pos.costDown;
            console.log(`   📊 ${m.marketKey}: ${status} $${totalInv.toFixed(2)} | ${timeLeft}m left`);
        } else if (timeLeft < 2) {
            console.log(`   ⏰ ${m.marketKey}: Too close to expiration (${timeLeft}m)`);
        } else {
            console.log(`   🎯 ${m.marketKey}: READY (${timeLeft}m left) UP:${m.priceUp?.toFixed(2)} DOWN:${m.priceDown?.toFixed(2)}`);
        }
    }
}

/**
 * Initialize - mark historical trades as processed
 */
const init = async () => {
    const isMongoConnected = mongoose.connection.readyState === 1;

    if (isMongoConnected) {
        Logger.info('Marking historical trades as processed...');
        for (const { address, UserActivity } of userModels) {
            const count = await UserActivity.updateMany(
                { bot: false },
                { $set: { bot: true, botExcutedTime: 999 } }
            );
            if (count.modifiedCount > 0) {
                Logger.info(`Marked ${count.modifiedCount} trades for ${address.slice(0, 6)}...${address.slice(-4)}`);
            }
        }
    }
};

/**
 * Stop paper trade monitor gracefully
 */
export const stopPaperTradeMonitor = () => {
    isRunning = false;
    Logger.info('Paper trade monitor shutdown requested...');
};

/**
 * Main paper trade monitor loop
 */
const paperTradeMonitor = async () => {
    Logger.success('═══════════════════════════════════════════════════════════');
    Logger.success('  PAPER BOT - Expiration Arbitrage Strategy');
    Logger.success('═══════════════════════════════════════════════════════════');
    Logger.info(`Starting capital: $${PAPER_STARTING_CAPITAL.toFixed(2)}`);
    Logger.info('');
    Logger.info('Strategy:');
    Logger.info('  1. PROACTIVELY discover upcoming 15min/hourly markets');
    Logger.info('  2. Split into UP + DOWN (following watcher bias patterns)');
    Logger.info('  3. Wait until 1-2 min before expiration');
    Logger.info('  4. If clear winner (95%+): buy loser for 1-2 cents');
    Logger.info('  5. If unclear: do nothing, take collateral back');
    Logger.info('  6. Collect ~1-2% gain per cycle');
    Logger.info('');
    Logger.info(`📊 Watching ${USER_ADDRESSES.length} trader(s) for market discovery`);
    Logger.info(`🔄 Note: 15-min markets are discovered when watcher trades on them`);
    Logger.separator();

    await init();

    // Set market tracker to PAPER mode and CLEAR existing stats
    // This ensures we start fresh and don't show watcher's accumulated stats
    marketTracker.setDisplayMode('PAPER');
    marketTracker.clear(); // Clear all market stats from previous runs/watcher mode
    Logger.info('🧹 Cleared marketTracker stats for fresh paper mode start');

    // Check if marketTracker already has markets (should be 0 after clear)
    const existingMarkets = marketTracker.getMarkets();
    debugLog(`STARTUP: marketTracker has ${existingMarkets.size} markets`);
    Logger.info(`Starting with ${existingMarkets.size} markets already in marketTracker`);
    if (existingMarkets.size > 0) {
        for (const [key, m] of existingMarkets.entries()) {
            debugLog(`   - ${key}: ${m.marketName}`);
        }
    }

    let lastDisplayTime = 0;
    let lastCleanupTime = 0;
    const DISPLAY_INTERVAL_MS = 5000;
    const CLEANUP_INTERVAL_MS = 30000; // Clean up expired markets every 30 seconds
    let loopCount = 0;

    // Do initial cleanup
    Logger.info('🧹 Cleaning up any expired markets...');
    await cleanupExpiredMarketsAndPositions();

    while (isRunning) {
        try {
            const now = Date.now();
            loopCount++;

            // Log every 10 iterations to track progress
            if (loopCount % 10 === 1) {
                debugLog(`Main loop iteration ${loopCount}`);
            }

            // Cleanup expired markets (every 30 seconds)
            if (now - lastCleanupTime >= CLEANUP_INTERVAL_MS) {
                await cleanupExpiredMarketsAndPositions();
                lastCleanupTime = now;
            }

            // Discover markets from watched traders (still useful for syncing state)
            await discoverMarketsFromWatchers();

            // Log discoveredMarkets status after sync
            if (discoveredMarkets.size === 0 && marketTracker.getMarkets().size > 0) {
                debugLog(`⚠️ discoveredMarkets is still empty after sync! marketTracker has ${marketTracker.getMarkets().size} markets`);
            } else if (discoveredMarkets.size > 0) {
                debugLog(`✓ discoveredMarkets has ${discoveredMarkets.size} markets`);
            }

            // Update prices for all discovered markets
            await updatePrices();

            // Process each discovered market
            debugLog(`Processing ${discoveredMarkets.size} discovered markets...`);
            for (const [conditionId, market] of discoveredMarkets.entries()) {
                // Only skip if endDate is set AND has passed
                // If endDate is 0/undefined, we still process the market
                if (market.endDate && market.endDate > 0 && market.endDate <= now) {
                    debugLog(`  SKIP ${market.marketKey}: expired (endDate ${new Date(market.endDate).toISOString()} <= now)`);
                    continue;
                }

                // Look up position by conditionId (unique per market instance)
                const position = positions.get(conditionId);

                // Check if we're still building this position (use conditionId)
                const isBuilding = buildingPositions.has(conditionId);

                // Debug log every iteration to see what state each market is in
                let timeLeft = 0;
                if (market.endDate && market.endDate > 0) {
                    // If endDate is less than 10000000000, it's likely in seconds, convert to ms
                    const endDateMs = market.endDate < 10000000000 ? market.endDate * 1000 : market.endDate;
                    const timeDiff = endDateMs - now;
                    timeLeft = Math.max(0, Math.floor(timeDiff / 60000)); // Ensure non-negative
                }
                const hasAssets = market.assetUp && market.assetDown;
                if (!hasAssets) {
                    debugLog(`  WAIT ${market.marketKey}: no assets yet (UP:${market.assetUp ? '✓' : '✗'} DOWN:${market.assetDown ? '✗' : '✗'})`);
                } else if (isBuilding) {
                    // Continue building position with more trades
                    await buildPositionIncrementally(market);
                } else if (!position) {
                    // Start building position incrementally (like watcher does)
                    debugLog(`  START ${market.marketKey}: starting build (${timeLeft}m left)`);
                    await buildPositionIncrementally(market);
                } else if (position && !position.hasArbitragePosition && !position.isSettled) {
                    // Try to execute arbitrage trade near expiration
                    debugLog(`  ARB ${market.marketKey}: waiting for arbitrage (${timeLeft}m left, hasArb:${position.hasArbitragePosition}, settled:${position.isSettled})`);
                    await executeArbitrageTrade(position, market);
                } else {
                    debugLog(`  DONE ${market.marketKey}: position finalized (hasArb:${position?.hasArbitragePosition}, settled:${position?.isSettled})`);
                }
            }

            // Log discovered markets count periodically
            if (now - lastDisplayTime >= DISPLAY_INTERVAL_MS && discoveredMarkets.size === 0) {
                Logger.info(`🔍 No markets discovered yet. Watching ${USER_ADDRESSES.length} trader(s)...`);
            }

            // Settle expired positions
            await settlePositions();

            // Display status periodically
            // NOTE: marketTracker.displayStats() clears the screen, so we need to
            // display our status AFTER it, or integrate into marketTracker's display
            if (now - lastDisplayTime >= DISPLAY_INTERVAL_MS) {
                // First let marketTracker clear screen and show its display
                await marketTracker.displayStats();
                // Then show paper bot status on top (marketTracker already cleared screen)
                displayStatus();
                lastDisplayTime = now;
            }

            if (!isRunning) break;

            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        } catch (error) {
            Logger.error(`Error in paper trade monitor: ${error}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    displayStatus();
    Logger.info('Paper trade monitor stopped');
};

export default paperTradeMonitor;
