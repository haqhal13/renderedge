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
import chalk from 'chalk';
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

// Per-market allocation (from 57,259 trades: Max $6,793, Avg $3,610 per BTC 15m window)
// BTC gets more capital (67.3% BTC vs 32.7% ETH)
const PAPER_BTC_MAX_PER_MARKET = parseFloat(process.env.PAPER_BTC_MAX_PER_MARKET || '3600');
const PAPER_ETH_MAX_PER_MARKET = parseFloat(process.env.PAPER_ETH_MAX_PER_MARKET || '2400');

// =============================================================================
// THE SECRET SAUCE: EXACT WATCHER SHARE DISTRIBUTIONS (Dec 27-28 - 57,259 trades!)
// KEY INSIGHT: 22 shares is #1 for BTC at 18.8%! ETH 12 shares at 40.9%!
// BTC 15m: 22(18.8%), 5(12.5%), 1(6.8%), 2(6.7%), 21(5.5%)
// ETH 15m: 12(40.9%!), 11(10.7%), 10(8.1%), 8(6.0%), 5(5.8%)
// =============================================================================
// BTC 15-min share distribution (32,166 trades analyzed - Dec 27-28)
// 22 shares dominates at 18.8%, followed by 5 shares at 12.5%
const BTC_15M_SHARE_AMOUNTS = [22, 5, 1, 2, 21, 20, 10, 3, 6, 19, 4, 7, 8, 16, 17];
const BTC_15M_SHARE_WEIGHTS = [18.8, 12.5, 6.8, 6.7, 5.5, 4.6, 4.3, 3.9, 3.8, 3.1, 3.0, 2.8, 2.7, 2.7, 2.5];

// ETH 15-min share distribution (13,530 trades analyzed) - 12 shares DOMINATES at 40.9%!
const ETH_15M_SHARE_AMOUNTS = [12, 11, 10, 8, 5, 9, 2, 7, 6, 1, 3, 4];
const ETH_15M_SHARE_WEIGHTS = [40.9, 10.7, 8.1, 6.0, 5.8, 5.3, 4.8, 4.5, 4.2, 3.4, 2.9, 2.6];

// 1-hour market share distribution (BTC 6,354 trades, ETH 5,209 trades)
// BTC 1h: 16 shares dominates at 24%, ETH 1h: 10 shares dominates at 41.4%
const BTC_1H_SHARE_AMOUNTS = [16, 15, 5, 12, 10, 14, 9, 11, 2, 1];
const BTC_1H_SHARE_WEIGHTS = [24.0, 9.5, 8.7, 6.9, 6.5, 6.3, 4.7, 4.2, 4.2, 3.7];

const ETH_1H_SHARE_AMOUNTS = [10, 9, 5, 7, 6, 8, 1, 2, 3];
const ETH_1H_SHARE_WEIGHTS = [41.4, 16.5, 7.4, 7.0, 5.3, 5.1, 4.3, 4.3, 3.5];

// Legacy fallback
const TARGET_SHARE_AMOUNTS = BTC_15M_SHARE_AMOUNTS;
const SHARE_WEIGHTS = BTC_15M_SHARE_WEIGHTS;
const MIN_SHARES = 0.5;

// =============================================================================
// TIMING PATTERNS (from Dec 27-28 - 57,259 trades analysis)
// CRITICAL: 72.6% at 2-3s, 13.7% at 4-5s, 8.5% at 5-10s
// Average gap: 3.56s, Median gap: 2.00s
// No trades in 0-1s, 1-2s, or 3-4s buckets - watcher uses discrete intervals
// =============================================================================
const BATCH_INTERVAL_MS = 2500; // Increased from 2000ms
const BASE_GAP_MS = 2500; // Base gap between trades
const POLL_INTERVAL_MS = 1; // Poll interval - maximum speed (20/sec)

// Direction balance: ~50/50 - BTC: 50.9% UP, ETH: 49.9% UP (from 57,259 trades)
const BTC_UP_BIAS = 0.509; // BTC slightly favors UP
const ETH_UP_BIAS = 0.499; // ETH is truly 50/50
const UP_BIAS = 0.504; // Overall average
const DIRECTION_VARIANCE = 0.01;

// BTC vs ETH allocation: 67.3% BTC, 32.7% ETH (from 57,259 trades)
const BTC_ALLOCATION_RATIO = 0.673;

// =============================================================================
// MOMENTUM CHASING - ANALYSIS SHOWS NO MOMENTUM BIAS!
// Dec 26 data: When priceUp 0.30-0.60, watcher buys 49-51% UP consistently
// This means NO momentum chasing - just pure 50/50 hedging strategy
// Keeping these params but setting to 0 to disable
// =============================================================================
const MOMENTUM_CHASE_FACTOR = 0.0; // DISABLED - no momentum chasing
const PRICE_THRESHOLD_FOR_CHASE = 0.10; // Not used when factor is 0
const REBALANCE_CHECK_INTERVAL_MS = 10000; // Not used when factor is 0

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
    tradeCountUp: number;  // Number of UP trades executed (for accurate display)
    tradeCountDown: number; // Number of DOWN trades executed (for accurate display)
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

// Track which slugs we've already tried to fetch (to avoid repeated API calls)
const fetchedSlugs = new Set<string>();

/**
 * Fetch missing asset IDs from Gamma API using conditionId or slug
 * Returns { assetUp, assetDown } or null if not found
 */
async function fetchMarketAssets(conditionId: string, slug?: string): Promise<{ assetUp: string; assetDown: string } | null> {
    if (!conditionId && !slug) {
        return null;
    }

    try {
        // Try fetching by slug first (more reliable for new 15-min markets)
        if (slug) {
            const slugUrl = `https://gamma-api.polymarket.com/events?slug=${slug}`;
            const data = await fetchData(slugUrl).catch(() => null);
            if (data && data.length > 0) {
                const event = data[0];
                const markets = event.markets || [];
                if (markets.length > 0) {
                    const market = markets[0];
                    const clobTokenIds = market.clobTokenIds || [];
                    if (clobTokenIds.length >= 2) {
                        const outcomes = market.outcomes || ['Up', 'Down'];
                        const isFirstUp = outcomes[0]?.toLowerCase().includes('up');
                        const assetUp = isFirstUp ? clobTokenIds[0] : clobTokenIds[1];
                        const assetDown = isFirstUp ? clobTokenIds[1] : clobTokenIds[0];
                        debugLog(`fetchMarketAssets: Found assets via slug ${slug}: UP=${assetUp?.slice(0,8)}..., DOWN=${assetDown?.slice(0,8)}...`);
                        return { assetUp, assetDown };
                    }
                }
            }
        }

        // Fallback: Fetch from general markets list by conditionId
        if (conditionId) {
            const gammaUrl = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500`;
            const marketList = await fetchData(gammaUrl).catch(() => null);

            if (Array.isArray(marketList)) {
                const marketData = marketList.find((m: any) => m.condition_id === conditionId);
                if (marketData && marketData.clobTokenIds && marketData.clobTokenIds.length >= 2) {
                    const outcomes = marketData.outcomes || ['Up', 'Down'];
                    const isFirstUp = outcomes[0]?.toLowerCase().includes('up');
                    const assetUp = isFirstUp ? marketData.clobTokenIds[0] : marketData.clobTokenIds[1];
                    const assetDown = isFirstUp ? marketData.clobTokenIds[1] : marketData.clobTokenIds[0];
                    debugLog(`fetchMarketAssets: Found assets for ${conditionId}: UP=${assetUp?.slice(0,8)}..., DOWN=${assetDown?.slice(0,8)}...`);
                    return { assetUp, assetDown };
                }
            }
        }
    } catch (e) {
        debugLog(`fetchMarketAssets failed for ${conditionId}/${slug}: ${e}`);
    }
    return null;
}

/**
 * PROACTIVE MARKET DISCOVERY
 * Instead of waiting for watcher to trade, directly search for the 4 market types:
 * - BTC 15-min: btc-updown-15m-{timestamp}
 * - ETH 15-min: eth-updown-15m-{timestamp}
 * - BTC Hourly: bitcoin-up-or-down-{month}-{day}-{hour}am-et
 * - ETH Hourly: ethereum-up-or-down-{month}-{day}-{hour}am-et
 */
// Track the last window we processed to detect window changes
let lastProcessedWindow = 0;
let lastHourProcessed = -1;

async function proactivelyDiscoverMarkets(): Promise<void> {
    const now = Date.now();

    // Calculate 15-minute boundaries IN EASTERN TIME (markets start at :00, :15, :30, :45 ET)
    // CRITICAL: Polymarket uses ET time for market windows, not UTC!
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;

    // Get current ET time components
    const etTimeFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const etTimeParts = etTimeFormatter.formatToParts(new Date(now));
    const currentETHour24 = parseInt(etTimeParts.find(p => p.type === 'hour')?.value || '0', 10);
    const currentETMinute = parseInt(etTimeParts.find(p => p.type === 'minute')?.value || '0', 10);

    // Calculate current 15-min window start minute (0, 15, 30, or 45)
    const windowStartMinute = Math.floor(currentETMinute / 15) * 15;

    // Build the ET window start time
    // Get today's date in ET
    const etDateFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const etDateParts = etDateFormatter.formatToParts(new Date(now));
    const etYear = parseInt(etDateParts.find(p => p.type === 'year')?.value || '2025', 10);
    const etMonthNum = parseInt(etDateParts.find(p => p.type === 'month')?.value || '1', 10);
    const etDayNum = parseInt(etDateParts.find(p => p.type === 'day')?.value || '1', 10);

    // Create the window start as a date in ET, then convert to UTC timestamp
    const windowStartETStr = `${etYear}-${String(etMonthNum).padStart(2, '0')}-${String(etDayNum).padStart(2, '0')}T${String(currentETHour24).padStart(2, '0')}:${String(windowStartMinute).padStart(2, '0')}:00`;
    // Parse as local time first, then adjust for ET offset
    const tempWindowDate = new Date(windowStartETStr);
    const etOffset = new Date(tempWindowDate.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime() -
                     new Date(tempWindowDate.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
    const currentWindowStart = tempWindowDate.getTime() - etOffset;
    const nextWindowStart = currentWindowStart + FIFTEEN_MIN_MS;

    debugLog(`15m window calc: ETHour=${currentETHour24} ETMin=${currentETMinute} windowMin=${windowStartMinute} -> ${new Date(currentWindowStart).toISOString()}`);

    // Generate hourly market slugs - MUST use Eastern Time to match Polymarket slugs
    // Get current time in ET timezone
    const etFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        hour12: true,
    });
    const etParts = etFormatter.formatToParts(new Date(now));
    const etMonth = etParts.find(p => p.type === 'month')?.value?.toLowerCase() || 'january';
    const etDay = parseInt(etParts.find(p => p.type === 'day')?.value || '1', 10);
    const etHourRaw = parseInt(etParts.find(p => p.type === 'hour')?.value || '12', 10);
    const etDayPeriod = etParts.find(p => p.type === 'dayPeriod')?.value?.toLowerCase() || 'am';

    // Convert to 24-hour format for calculations
    let currentHourET = etHourRaw;
    if (etDayPeriod === 'pm' && etHourRaw !== 12) currentHourET += 12;
    if (etDayPeriod === 'am' && etHourRaw === 12) currentHourET = 0;
    const nextHourET = (currentHourET + 1) % 24;

    // CRITICAL: Clear the fetched slugs cache when a new window OR hour starts
    // This ensures we immediately discover new markets
    const windowChanged = currentWindowStart !== lastProcessedWindow;
    const hourChanged = currentHourET !== lastHourProcessed;

    if (windowChanged || hourChanged) {
        fetchedSlugs.clear();
        lastProcessedWindow = currentWindowStart;
        lastHourProcessed = currentHourET;
        debugLog(`🔄 New ${windowChanged ? '15-min window' : 'hour'} detected! Scanning for new markets...`);

        // =======================================================================
        // NOTE: We do NOT delete buildStates here - they need to remain visible
        // until the market timer fully expires. The buildPositionIncrementally
        // function already checks for old windows and skips trading on them.
        // buildStates are only deleted when the market's endDate passes (line ~475)
        // =======================================================================
        if (windowChanged) {
            debugLog(`🔄 Window changed to ${new Date(currentWindowStart).toISOString()} - old markets will stop trading but remain visible`);
        }
    }

    // ==========================================================================
    // CLEANUP: Remove ONLY truly expired markets (after grace period)
    // Keep markets visible for 60 seconds after endDate to prevent data reset
    // ==========================================================================
    const CLEANUP_GRACE_PERIOD_MS = 60 * 1000; // 60 seconds grace period

    for (const [id, market] of discoveredMarkets.entries()) {
        const endDateMs = market.endDate && market.endDate < 10000000000
            ? market.endDate * 1000
            : market.endDate;

        // ONLY remove if expired BEYOND grace period (endDate + 60s has passed)
        if (endDateMs && endDateMs + CLEANUP_GRACE_PERIOD_MS <= now) {
            const buildState = buildingPositions.get(id);
            if (buildState) {
                if (buildState.investedUp > 0 || buildState.investedDown > 0) {
                    debugLog(`⏰ Market expired: Finalizing ${market.marketKey} (UP $${buildState.investedUp.toFixed(2)}, DOWN $${buildState.investedDown.toFixed(2)})`);
                    currentCapital += buildState.investedUp + buildState.investedDown;
                }
                buildingPositions.delete(id);
            }
            discoveredMarkets.delete(id);
            debugLog(`🗑️ Removed expired market: ${market.marketKey} | grace period ended`);
        }
    }

    // Clean up orphaned building positions (safety net)
    for (const [id, buildState] of buildingPositions.entries()) {
        if (!discoveredMarkets.has(id)) {
            debugLog(`🗑️ Removed orphaned building position: ${buildState.marketKey}`);
            currentCapital += buildState.investedUp + buildState.investedDown;
            buildingPositions.delete(id);
        }
    }

    // PRE-FETCH: Check how much time is left in current window
    // Start fetching NEXT markets 3 minutes before current window ends
    // This ensures markets are ready and tradeable immediately when the window switches
    const timeToNextWindow = nextWindowStart - now;
    const PRE_FETCH_THRESHOLD = 3 * 60 * 1000; // 3 minutes before window ends (was 60s)
    const shouldPreFetch = timeToNextWindow <= PRE_FETCH_THRESHOLD && timeToNextWindow > 0;

    // Generate next window slugs
    const nextBtcSlug = `btc-updown-15m-${Math.floor(nextWindowStart / 1000)}`;
    const nextEthSlug = `eth-updown-15m-${Math.floor(nextWindowStart / 1000)}`;

    // ALWAYS try to have next markets ready (not just in pre-fetch window)
    const haveNextBTC = Array.from(discoveredMarkets.values()).some(m =>
        m.marketSlug === nextBtcSlug && m.endDate && m.endDate > now
    );
    const haveNextETH = Array.from(discoveredMarkets.values()).some(m =>
        m.marketSlug === nextEthSlug && m.endDate && m.endDate > now
    );

    // If we don't have next markets and we're within pre-fetch window, force fetch
    if (shouldPreFetch || !haveNextBTC || !haveNextETH) {
        if (!haveNextBTC) {
            fetchedSlugs.delete(nextBtcSlug);
            if (shouldPreFetch) {
                debugLog(`⏰ Pre-fetching next BTC 15m (${Math.floor(timeToNextWindow/1000)}s until switch)`);
            }
        }
        if (!haveNextETH) {
            fetchedSlugs.delete(nextEthSlug);
            if (shouldPreFetch) {
                debugLog(`⏰ Pre-fetching next ETH 15m (${Math.floor(timeToNextWindow/1000)}s until switch)`);
            }
        }
    }

    // Same for hourly markets - pre-fetch when less than 5 minutes left in hour
    const nextHourStart = new Date(now);
    nextHourStart.setMinutes(0, 0, 0);
    nextHourStart.setHours(nextHourStart.getHours() + 1);
    // Adjust for ET timezone
    const etNow = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const currentMinuteET = etNow.getMinutes();
    const timeToNextHour = (60 - currentMinuteET) * 60 * 1000 - (etNow.getSeconds() * 1000);
    const HOURLY_PRE_FETCH_THRESHOLD = 5 * 60 * 1000; // 5 minutes for hourly

    if (timeToNextHour <= HOURLY_PRE_FETCH_THRESHOLD && timeToNextHour > 0) {
        debugLog(`⏰ Pre-fetching next hourly markets (${Math.floor(timeToNextHour/1000)}s until hour change)`);
    }

    // FORCE: Check if we're missing any active 15-min markets and force re-fetch
    const have15mBTC = Array.from(discoveredMarkets.values()).some(m =>
        m.marketKey === 'BTC-UpDown-15' && m.endDate && m.endDate > now
    );
    const have15mETH = Array.from(discoveredMarkets.values()).some(m =>
        m.marketKey === 'ETH-UpDown-15' && m.endDate && m.endDate > now
    );

    // Log what's missing and force retry
    if (!have15mBTC) {
        debugLog(`⚠️ Missing BTC-15m market - forcing re-fetch`);
        fetchedSlugs.delete(`btc-updown-15m-${Math.floor(currentWindowStart / 1000)}`);
    }
    if (!have15mETH) {
        debugLog(`⚠️ Missing ETH-15m market - forcing re-fetch`);
        fetchedSlugs.delete(`eth-updown-15m-${Math.floor(currentWindowStart / 1000)}`);
    }

    // Same for hourly markets
    const have1hBTC = Array.from(discoveredMarkets.values()).some(m =>
        m.marketKey.startsWith('BTC-UpDown-1h') && m.endDate && m.endDate > now
    );
    const have1hETH = Array.from(discoveredMarkets.values()).some(m =>
        m.marketKey.startsWith('ETH-UpDown-1h') && m.endDate && m.endDate > now
    );

    // Format hour for slug (needed early for force re-fetch)
    const formatHourForSlug = (h: number) => h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;

    if (!have1hBTC) {
        debugLog(`⚠️ Missing BTC-1h market - forcing re-fetch`);
        fetchedSlugs.delete(`bitcoin-up-or-down-${etMonth}-${etDay}-${formatHourForSlug(currentHourET)}-et`);
    }
    if (!have1hETH) {
        debugLog(`⚠️ Missing ETH-1h market - forcing re-fetch`);
        fetchedSlugs.delete(`ethereum-up-or-down-${etMonth}-${etDay}-${formatHourForSlug(currentHourET)}-et`);
    }

    // Generate 15-minute market slugs (current and next window)
    const btcSlugCurrent = `btc-updown-15m-${Math.floor(currentWindowStart / 1000)}`;
    const ethSlugCurrent = `eth-updown-15m-${Math.floor(currentWindowStart / 1000)}`;
    const btcSlugNext = `btc-updown-15m-${Math.floor(nextWindowStart / 1000)}`;
    const ethSlugNext = `eth-updown-15m-${Math.floor(nextWindowStart / 1000)}`;

    // Use the formatHourForSlug function defined above
    const btcHourlyCurrent = `bitcoin-up-or-down-${etMonth}-${etDay}-${formatHourForSlug(currentHourET)}-et`;
    const ethHourlyCurrent = `ethereum-up-or-down-${etMonth}-${etDay}-${formatHourForSlug(currentHourET)}-et`;
    const btcHourlyNext = `bitcoin-up-or-down-${etMonth}-${etDay}-${formatHourForSlug(nextHourET)}-et`;
    const ethHourlyNext = `ethereum-up-or-down-${etMonth}-${etDay}-${formatHourForSlug(nextHourET)}-et`;

    // All slugs to check
    const slugsToCheck = [
        btcSlugCurrent, ethSlugCurrent, btcSlugNext, ethSlugNext,
        btcHourlyCurrent, ethHourlyCurrent, btcHourlyNext, ethHourlyNext
    ];

    // Log what we're looking for - use debugLog to avoid terminal spam
    debugLog(`🔍 Checking: ${btcSlugCurrent.split('-').pop()}, ${ethSlugCurrent.split('-').pop()} | cache: ${fetchedSlugs.size} | discovered: ${discoveredMarkets.size}`);

    // Fetch markets in parallel for speed
    const fetchPromises = slugsToCheck.map(async (slug) => {
        // Check if we already have this market by slug
        let alreadyHave = false;
        for (const [_, market] of discoveredMarkets.entries()) {
            if (market.marketSlug === slug && market.endDate && market.endDate > now) {
                alreadyHave = true;
                break;
            }
        }
        if (alreadyHave) {
            return;
        }

        // Skip if fetched recently (within last 5 seconds) to avoid API spam
        // BUT always retry if it's a current window market we don't have
        const isCurrent15m = slug === btcSlugCurrent || slug === ethSlugCurrent;
        const isCurrent1h = slug === btcHourlyCurrent || slug === ethHourlyCurrent;
        const isCurrentMarket = isCurrent15m || isCurrent1h;

        if (fetchedSlugs.has(slug) && !isCurrentMarket) {
            return;
        }

        debugLog(`   📡 Fetching: ${slug}${isCurrentMarket ? ' (CURRENT - priority)' : ''}`);

        // DON'T mark as fetched until AFTER success - allows retry on failure
        try {
            const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;
            const data = await fetchData(url).catch((e) => {
                debugLog(`   ❌ Fetch failed for ${slug}: ${e}`);
                return null;
            });

            if (data && Array.isArray(data) && data.length > 0) {
                const event = data[0];

                // Extract market data from nested structure
                const markets = event.markets || [];
                if (markets.length === 0) {
                    // Don't mark as fetched if no markets - allow retry
                    debugLog(`   ⚠️ No markets in event for ${slug}`);
                    return;
                }

                const market = markets[0];
                const conditionId = market.conditionId || market.condition_id;

                // Parse clobTokenIds - API returns it as JSON string, not array
                let clobTokenIds: string[] = [];
                if (typeof market.clobTokenIds === 'string') {
                    try {
                        clobTokenIds = JSON.parse(market.clobTokenIds);
                    } catch (e) {
                        debugLog(`Failed to parse clobTokenIds for ${slug}: ${e}`);
                        return;
                    }
                } else if (Array.isArray(market.clobTokenIds)) {
                    clobTokenIds = market.clobTokenIds;
                }

                if (!conditionId || clobTokenIds.length < 2) return;

                // Determine which token is UP and which is DOWN
                // Parse outcomes - API returns it as JSON string, not array
                let outcomes: string[] = ['Up', 'Down'];
                if (typeof market.outcomes === 'string') {
                    try {
                        outcomes = JSON.parse(market.outcomes);
                    } catch (e) {
                        // Use default
                    }
                } else if (Array.isArray(market.outcomes)) {
                    outcomes = market.outcomes;
                }
                const isFirstUp = outcomes[0]?.toLowerCase().includes('up');
                const assetUp = isFirstUp ? clobTokenIds[0] : clobTokenIds[1];
                const assetDown = isFirstUp ? clobTokenIds[1] : clobTokenIds[0];

                // Parse endDate
                let endDate = 0;
                if (market.endDate) {
                    endDate = typeof market.endDate === 'string'
                        ? new Date(market.endDate).getTime()
                        : market.endDate < 10000000000 ? market.endDate * 1000 : market.endDate;
                } else if (event.endDate) {
                    endDate = typeof event.endDate === 'string'
                        ? new Date(event.endDate).getTime()
                        : event.endDate < 10000000000 ? event.endDate * 1000 : event.endDate;
                }

                // FALLBACK: Calculate endDate from slug if not provided by API
                if (!endDate || endDate === 0) {
                    // For 15-min markets: btc-updown-15m-{timestamp}
                    const timestamp15Match = slug.match(/updown-15m-(\d+)/);
                    if (timestamp15Match) {
                        const startTime = parseInt(timestamp15Match[1], 10) * 1000;
                        endDate = startTime + (15 * 60 * 1000); // 15 minutes from start
                    }
                    // For hourly markets: bitcoin-up-or-down-december-26-10am-et
                    const hourlyMatch = slug.match(/(\w+)-(\d+)-(\d{1,2})(am|pm)-et$/i);
                    if (hourlyMatch) {
                        const monthName = hourlyMatch[1];
                        const day = parseInt(hourlyMatch[2], 10);
                        let hour = parseInt(hourlyMatch[3], 10);
                        const ampm = hourlyMatch[4].toLowerCase();
                        if (ampm === 'pm' && hour !== 12) hour += 12;
                        if (ampm === 'am' && hour === 12) hour = 0;

                        // Calculate end time (1 hour after start)
                        const months: {[key: string]: number} = {
                            january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
                            july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
                        };
                        const monthNum = months[monthName.toLowerCase()] ?? 0;
                        const year = new Date().getFullYear();

                        // Create a date string in ET and parse it properly
                        // Market "10am ET" runs from 10am to 11am ET
                        // Use Intl.DateTimeFormat to convert ET to UTC properly
                        const etDateStr = `${year}-${String(monthNum + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`;
                        // Parse as ET time by creating a formatter and using its timezone offset
                        const tempDate = new Date(etDateStr);
                        // Get timezone offset for ET on this date
                        const etOffset = new Date(tempDate.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime() -
                                         new Date(tempDate.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
                        const startTimeUTC = tempDate.getTime() - etOffset;
                        endDate = startTimeUTC + (60 * 60 * 1000); // 1 hour from start

                        debugLog(`HOURLY endDate calculated: ${slug} -> ${new Date(endDate).toISOString()}`);
                    }
                }

                // Skip if expired
                if (endDate && endDate < now - 60000) return;

                // Get market title and key
                const title = market.question || event.title || slug;
                const marketKey = getMarketKey(title);

                // Add to discovered markets
                const newMarket = {
                    conditionId,
                    marketKey,
                    marketName: title,
                    marketSlug: slug,
                    assetUp,
                    assetDown,
                    endDate,
                    priceUp: 0.5,
                    priceDown: 0.5,
                    lastUpdate: now,
                };

                if (!discoveredMarkets.has(conditionId)) {
                    // ==========================================================================
                    // Allow multiple markets with same marketKey to coexist (old + new)
                    // Old market stays visible until its timer runs out
                    // Only stop TRADING on old market, but keep it for display
                    // ==========================================================================

                    discoveredMarkets.set(conditionId, newMarket);
                    proactivelyDiscoveredIds.add(conditionId);

                    // Mark as fetched ONLY after successful discovery
                    fetchedSlugs.add(slug);

                    // CRITICAL: Ensure market exists in marketTracker with both assets for live price fetching
                    marketTracker.ensureMarketWithAssets(marketKey, title, slug, conditionId, assetUp, assetDown, endDate);

                    const timeLeftMin = endDate ? Math.floor((endDate - now) / 60000) : 0;
                    debugLog(`🎯 PROACTIVE DISCOVERY: ${marketKey} | ${slug} | ${timeLeftMin}m left | assets: UP=${assetUp?.slice(0,8)}..., DOWN=${assetDown?.slice(0,8)}...`);
                    debugLog(`🎯 PROACTIVE: Found ${marketKey} | ${timeLeftMin}m remaining`);
                }
            }
        } catch (e) {
            // Silent fail - will retry next loop
            debugLog(`Proactive fetch failed for ${slug}: ${e}`);
        }
    });

    // Wait for all fetches to complete (parallel for speed)
    await Promise.all(fetchPromises);

    // ==========================================================================
    // FALLBACK: If still missing current 15-min markets after slug lookup,
    // try search API which might find them before slug is fully indexed
    // ==========================================================================
    const stillMissingBTC15m = !Array.from(discoveredMarkets.values()).some(m =>
        m.marketKey === 'BTC-UpDown-15' && m.endDate && m.endDate > now
    );
    const stillMissingETH15m = !Array.from(discoveredMarkets.values()).some(m =>
        m.marketKey === 'ETH-UpDown-15' && m.endDate && m.endDate > now
    );

    if (stillMissingBTC15m || stillMissingETH15m) {
        debugLog(`🔄 FALLBACK: Using search API (BTC missing: ${stillMissingBTC15m}, ETH missing: ${stillMissingETH15m})`);

        try {
            // Search for recent 15-min markets
            const searchUrl = 'https://gamma-api.polymarket.com/events?tag=crypto&limit=20&active=true';
            const searchData = await fetchData(searchUrl).catch(() => null);

            if (searchData && Array.isArray(searchData)) {
                for (const event of searchData) {
                    const title = (event.title || '').toLowerCase();
                    const slug = event.slug || '';

                    // Check if this is a 15-min BTC or ETH market we need
                    const isBTC15m = (title.includes('bitcoin') || title.includes('btc')) &&
                                     slug.includes('updown-15m');
                    const isETH15m = (title.includes('ethereum') || title.includes('eth')) &&
                                     slug.includes('updown-15m');

                    if ((stillMissingBTC15m && isBTC15m) || (stillMissingETH15m && isETH15m)) {
                        const markets = event.markets || [];
                        if (markets.length === 0) continue;

                        const market = markets[0];
                        const conditionId = market.conditionId || market.condition_id;

                        // Skip if already discovered
                        if (discoveredMarkets.has(conditionId)) continue;

                        // Parse clobTokenIds
                        let clobTokenIds: string[] = [];
                        if (typeof market.clobTokenIds === 'string') {
                            try { clobTokenIds = JSON.parse(market.clobTokenIds); } catch { continue; }
                        } else if (Array.isArray(market.clobTokenIds)) {
                            clobTokenIds = market.clobTokenIds;
                        }
                        if (!conditionId || clobTokenIds.length < 2) continue;

                        // Parse outcomes
                        let outcomes: string[] = ['Up', 'Down'];
                        if (typeof market.outcomes === 'string') {
                            try { outcomes = JSON.parse(market.outcomes); } catch { /* use default */ }
                        } else if (Array.isArray(market.outcomes)) {
                            outcomes = market.outcomes;
                        }
                        const isFirstUp = outcomes[0]?.toLowerCase().includes('up');
                        const assetUp = isFirstUp ? clobTokenIds[0] : clobTokenIds[1];
                        const assetDown = isFirstUp ? clobTokenIds[1] : clobTokenIds[0];

                        // Calculate endDate from slug
                        let endDate = 0;
                        const timestamp15Match = slug.match(/updown-15m-(\d+)/);
                        if (timestamp15Match) {
                            const startTime = parseInt(timestamp15Match[1], 10) * 1000;
                            endDate = startTime + (15 * 60 * 1000);
                        }

                        // Skip if expired
                        if (endDate && endDate < now) continue;

                        const marketKey = isBTC15m ? 'BTC-UpDown-15' : 'ETH-UpDown-15';
                        const newMarket = {
                            conditionId,
                            marketKey,
                            marketName: event.title || slug,
                            marketSlug: slug,
                            assetUp,
                            assetDown,
                            endDate,
                            priceUp: 0.5,
                            priceDown: 0.5,
                            lastUpdate: now,
                        };

                        discoveredMarkets.set(conditionId, newMarket);
                        proactivelyDiscoveredIds.add(conditionId);
                        marketTracker.ensureMarketWithAssets(marketKey, event.title, slug, conditionId, assetUp, assetDown, endDate);

                        const timeLeftMin = endDate ? Math.floor((endDate - now) / 60000) : 0;
                        debugLog(`🎯 FALLBACK FOUND: ${marketKey} | ${slug} | ${timeLeftMin}m left`);
                    }
                }
            }
        } catch (e) {
            debugLog(`Fallback search failed: ${e}`);
        }
    }

    // Note: Cache is now cleared at the start of each new 15-minute window
    // This ensures instant discovery of new markets
}

/**
 * Get market key from title or slug
 * MUST match marketTracker.extractMarketKey() for consistent market tracking
 */
function getMarketKey(title: string): string {
    const lowerTitle = title.toLowerCase();

    const isBTC = lowerTitle.includes('bitcoin') || lowerTitle.includes('btc');
    const isETH = lowerTitle.includes('ethereum') || lowerTitle.includes('eth');
    // 15-min markets have time range like "7:45PM-8:00PM" or "7:00AM-7:15AM"
    // The regex matches: HH:MM optionally followed by AM/PM, then dash, then HH:MM
    const is15Min = /\d{1,2}:\d{2}\s*(?:[AP]M)?\s*[-–]\s*\d{1,2}:\d{2}/i.test(title);
    // Handle both title format (with spaces: "5AM ET") and slug format (with hyphens: "5am-et")
    const isHourly = (/\d{1,2}\s*(?:am|pm)\s*et/i.test(title) || /\d{1,2}(?:am|pm)-et/i.test(title)) && !is15Min;

    // Extract hour for hourly markets - try both patterns
    let hourMatch = title.match(/(\d{1,2})\s*(?:am|pm)\s*et/i);
    if (!hourMatch) {
        hourMatch = title.match(/(\d{1,2})(?:am|pm)-et/i);
    }

    if (isBTC) {
        if (is15Min) return 'BTC-UpDown-15';
        if (isHourly && hourMatch) {
            return `BTC-UpDown-1h-${hourMatch[1]}`;
        }
        if (isHourly) return 'BTC-UpDown-1h';
        return 'BTC-UpDown';
    } else if (isETH) {
        if (is15Min) return 'ETH-UpDown-15';
        if (isHourly && hourMatch) {
            return `ETH-UpDown-1h-${hourMatch[1]}`;
        }
        if (isHourly) return 'ETH-UpDown-1h';
        return 'ETH-UpDown';
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
            // CRITICAL: If missing asset IDs, fetch from Gamma API for price fetching
            if ((!existing.assetUp || !existing.assetDown) && (market.conditionId || existing.marketSlug)) {
                const assets = await fetchMarketAssets(market.conditionId || '', existing.marketSlug);
                if (assets) {
                    existing.assetUp = assets.assetUp;
                    existing.assetDown = assets.assetDown;
                    // Also update marketTracker so it can fetch live prices
                    marketTracker.updateMarketAssets(market.conditionId || '', assets.assetUp, assets.assetDown, existing.marketKey);
                    debugLog(`Updated assets for ${existing.marketKey} from Gamma API`);
                }
            }
        } else {
            // New market from marketTracker
            let endDate = market.endDate || 0;
            let assetUp = market.assetUp || '';
            let assetDown = market.assetDown || '';

            // If endDate is missing, try to fetch from Gamma API
            if ((!endDate || endDate === 0) && market.conditionId) {
                const fetchedEndDate = await fetchMarketExpiration(market.conditionId);
                if (fetchedEndDate) {
                    endDate = fetchedEndDate;
                    debugLog(`Fetched endDate for ${market.marketKey} from Gamma API: ${new Date(fetchedEndDate).toISOString()}`);
                }
            }

            // CRITICAL: If missing asset IDs, fetch from Gamma API for price fetching
            if ((!assetUp || !assetDown) && (market.conditionId || market.marketSlug)) {
                const assets = await fetchMarketAssets(market.conditionId || '', market.marketSlug);
                if (assets) {
                    assetUp = assets.assetUp;
                    assetDown = assets.assetDown;
                    // Also update marketTracker so it can fetch live prices
                    marketTracker.updateMarketAssets(market.conditionId || '', assets.assetUp, assets.assetDown, market.marketKey);
                    debugLog(`Fetched assets for ${market.marketKey} from Gamma API`);
                }
            }

            const newMarket = {
                conditionId: id,
                marketKey: market.marketKey,
                marketName: market.marketName,
                marketSlug: market.marketSlug || '',
                assetUp,
                assetDown,
                endDate: endDate,
                priceUp: market.currentPriceUp || 0.5,
                priceDown: market.currentPriceDown || 0.5,
                lastUpdate: now,
            };

            // ==========================================================================
            // Allow multiple markets with same marketKey to coexist (old + new)
            // Old market stays visible until its timer runs out
            // ==========================================================================

            discoveredMarkets.set(id, newMarket);

            // CRITICAL: Ensure market exists in marketTracker with both assets for live price fetching
            if (assetUp && assetDown) {
                marketTracker.ensureMarketWithAssets(market.marketKey, market.marketName, market.marketSlug || '', id, assetUp, assetDown, endDate);
            }

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
            debugLog(`🎯 NEW MARKET DISCOVERED: ${market.marketKey} | ${timeLeftMin}m remaining | UP:${newMarket.assetUp ? '✓' : '✗'} DOWN:${newMarket.assetDown ? '✓' : '✗'}`);
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

    // Update in parallel batches - larger batch for faster updates
    const batchSize = 10;
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

            // CRITICAL: Sync prices AND assets to marketTracker for dashboard display
            // This ensures the dashboard shows live prices like watcher mode
            const trackerMarket = marketTracker.getMarkets().get(market.marketKey);
            if (trackerMarket) {
                if (priceUp !== null) trackerMarket.currentPriceUp = priceUp;
                if (priceDown !== null) trackerMarket.currentPriceDown = priceDown;
                trackerMarket.lastPriceUpdate = now;
                // Also ensure assets are synced
                if (market.assetUp) trackerMarket.assetUp = market.assetUp;
                if (market.assetDown) trackerMarket.assetDown = market.assetDown;
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

    // ==========================================================================
    // CRITICAL: MARKET VALIDITY CHECK - Prevent trades on wrong market window!
    // This catches cases where:
    // 1. Market has expired but hasn't been cleaned up yet
    // 2. Trade was scheduled before window change but executes after
    // 3. Stale market reference from previous iteration
    // ==========================================================================

    // First, verify this market still exists in discoveredMarkets
    if (!discoveredMarkets.has(positionKey)) {
        debugLog(`buildPosition: ${market.marketKey} - SKIPPED (market no longer in discoveredMarkets)`);
        // Clean up any orphaned building position
        const orphanedState = buildingPositions.get(positionKey);
        if (orphanedState) {
            currentCapital += orphanedState.investedUp + orphanedState.investedDown;
            buildingPositions.delete(positionKey);
            debugLog(`buildPosition: Cleaned up orphaned position for ${market.marketKey}`);
        }
        return;
    }

    // Skip if we don't have both assets
    if (!market.assetUp || !market.assetDown) {
        if (!discoveredConditionIds.has(`skip-assets-${positionKey}`)) {
            discoveredConditionIds.add(`skip-assets-${positionKey}`);
            debugLog(`buildPosition: ${market.marketKey} - missing assets`);
        }
        return;
    }

    // ==========================================================================
    // CRITICAL FIX: For 15-min markets, verify this is the CURRENT window!
    // This prevents trades on OLD markets that haven't expired yet
    // Only the current window should receive new trades
    // ==========================================================================
    if (market.marketKey.includes('-15') && market.marketSlug) {
        const slugTimestampMatch = market.marketSlug.match(/updown-15m-(\d+)/);
        if (slugTimestampMatch) {
            const marketStartTimestamp = parseInt(slugTimestampMatch[1], 10) * 1000;

            // Calculate what the CURRENT 15-min window should be
            const currentWindowStart = Math.floor(now / (15 * 60 * 1000)) * (15 * 60 * 1000);

            // If this market's start time doesn't match current window, skip trading!
            if (marketStartTimestamp !== currentWindowStart) {
                // First time we skip this market for being old, log it
                const skipKey = `skip-old-window-${positionKey}`;
                if (!discoveredConditionIds.has(skipKey)) {
                    discoveredConditionIds.add(skipKey);
                    debugLog(`buildPosition: ${market.marketKey} - SKIPPED (old window: market=${new Date(marketStartTimestamp).toISOString()}, current=${new Date(currentWindowStart).toISOString()})`);
                }
                return; // Don't trade on old windows!
            }
        }
    }

    // Skip if no valid prices
    if (!market.priceUp || !market.priceDown || market.priceUp <= 0 || market.priceDown <= 0) {
        return;
    }

    // ==========================================================================
    // WATCHER PATTERN: Trade ONLY in NEUTRAL zone (0.40-0.60)
    // Data shows: 100% of watcher trades happen when prices are 0.40-0.60
    // Watcher catches markets RIGHT when they open at 50/50
    // At extremes, the arbitrage opportunity is GONE - don't trade!
    // ==========================================================================
    const isNeutral = market.priceUp >= 0.35 && market.priceUp <= 0.65;

    // ONLY trade in neutral zone - skip ALL extreme price trades
    if (!isNeutral) {
        return; // Don't trade when prices have moved too far from 50/50
    }

    // Check time to expiration - stop building 2 min before expiration
    if (market.endDate && market.endDate > 0) {
        // If endDate is less than 10000000000, it's likely in seconds, convert to ms
        const endDateMs = market.endDate < 10000000000 ? market.endDate * 1000 : market.endDate;
        const timeToExpiration = endDateMs - now;

        // CRITICAL: If market has ALREADY EXPIRED, skip immediately and clean up
        if (timeToExpiration <= 0) {
            debugLog(`buildPosition: ${market.marketKey} - EXPIRED (${Math.abs(timeToExpiration/1000).toFixed(0)}s ago), cleaning up`);
            const buildState = buildingPositions.get(positionKey);
            if (buildState && buildState.investedUp > 0 && buildState.investedDown > 0 && !positions.has(positionKey)) {
                await finalizePosition(market, buildState);
            }
            // Remove from discoveredMarkets to prevent future allocation
            discoveredMarkets.delete(positionKey);
            buildingPositions.delete(positionKey);
            return;
        }

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
        // Dec 27-28 DATA (57,259 trades):
        // - 15m markets: 45,696 trades (79.8%) - HEAVY FOCUS!
        // - 1h markets: 11,563 trades (20.2%)
        // - BTC 15m: 32,166 (56.2%), ETH 15m: 13,530 (23.6%)
        // - BTC 1h: 6,354 (11.1%), ETH 1h: 5,209 (9.1%)
        // =======================================================================
        const isBTC = market.marketKey.includes('BTC');
        const is15m = market.marketKey.includes('15') || market.marketKey.includes('15m');
        const is1h = market.marketKey.includes('1h') || market.marketKey.includes('1h-');

        // Base max per market - 15m gets MUCH more than 1h
        // WATCHER DATA (last 30 mins): 15m = 3023 trades (90.8%), 1h = 305 trades (9.2%)
        // Ratio: 15m gets 10x more trades than 1h!
        let maxPerMarket: number;
        if (is15m) {
            maxPerMarket = isBTC ? PAPER_BTC_MAX_PER_MARKET : PAPER_ETH_MAX_PER_MARKET;
        } else {
            // 1h markets get only 5% of 15m allocation (watcher does 10x more on 15m!)
            maxPerMarket = (isBTC ? PAPER_BTC_MAX_PER_MARKET : PAPER_ETH_MAX_PER_MARKET) * 0.05;
        }

        // Watcher invests 2x more in BTC than ETH
        // BTC gets 75% of capital, ETH gets 50%
        const capitalRatio = isBTC ? 0.75 : 0.50;
        const positionSize = Math.min(maxPerMarket, currentCapital * capitalRatio);

        if (positionSize < 10) { // Minimum $10 per position
            return;
        }

        // WATCHER PATTERN: BTC 50.9% UP, ETH 49.9% UP (from 57,259 trades)
        const sessionVariance = (Math.random() - 0.5) * 2 * DIRECTION_VARIANCE;
        const baseUpBias = isBTC ? BTC_UP_BIAS : ETH_UP_BIAS;
        const upRatio = Math.max(0.48, Math.min(0.52, baseUpBias + sessionVariance));
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
            tradeCountUp: 0,   // Track UP trades separately
            tradeCountDown: 0, // Track DOWN trades separately
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
        debugLog(`📈 Building position: ${market.marketKey} | Target: UP $${buildState.targetUp.toFixed(2)} / DOWN $${buildState.targetDown.toFixed(2)}`);
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

    // ==========================================================================
    // 1H MARKET RATE LIMITING
    // Watcher: 64% on 15m, 36% on 1h (from Dec 28 data)
    // Only skip 30% of 1h market trade opportunities
    // ==========================================================================
    const is1hMarket = market.marketKey.includes('-1h');
    if (is1hMarket && Math.random() < 0.30) {
        return; // Skip 30% of 1h trades
    }

    // Keep trading like the watcher - but LIMIT 1h market growth
    if (upComplete && downComplete) {
        if (is1hMarket) {
            // 1h markets: DON'T grow - just stop when complete
            return; // Stop trading this 1h market when targets reached
        } else {
            // 15m markets: keep growing like watcher
            buildState.targetUp *= 1.1;
            buildState.targetDown *= 1.1;
        }
        debugLog(`buildPosition: ${market.marketKey} targets increased to UP:$${buildState.targetUp.toFixed(2)} DOWN:$${buildState.targetDown.toFixed(2)}`);
    }

    // ==========================================================================
    // THE SECRET SAUCE: MARKET-SPECIFIC SHARE DISTRIBUTIONS!
    // BTC and ETH have VERY different share patterns:
    // - BTC 15m: 28(12.8%), 5(11.7%), 1(10.4%) - larger trades
    // - ETH 15m: 16(45.6%!), 15(9.5%), 14(5.7%) - focused on 14-16 shares
    // - 1h markets: 22(19%), 2(18.6%) - polarized
    // ==========================================================================
    function selectTargetShares(): number {
        // Select distribution based on market type
        let shareAmounts: number[];
        let shareWeights: number[];

        const isBTC = market.marketKey.includes('BTC');
        const is15m = market.marketKey.includes('-15');
        const is1h = market.marketKey.includes('-1h');

        if (isBTC && is15m) {
            shareAmounts = BTC_15M_SHARE_AMOUNTS;
            shareWeights = BTC_15M_SHARE_WEIGHTS;
        } else if (!isBTC && is15m) {
            // ETH 15-min - 12 shares is #1 at 26.6%!
            shareAmounts = ETH_15M_SHARE_AMOUNTS;
            shareWeights = ETH_15M_SHARE_WEIGHTS;
        } else if (isBTC && is1h) {
            // BTC 1-hour - 22 shares is #1
            shareAmounts = BTC_1H_SHARE_AMOUNTS;
            shareWeights = BTC_1H_SHARE_WEIGHTS;
        } else if (!isBTC && is1h) {
            // ETH 1-hour - 12 shares is #1
            shareAmounts = ETH_1H_SHARE_AMOUNTS;
            shareWeights = ETH_1H_SHARE_WEIGHTS;
        } else {
            // Fallback to BTC 15m
            shareAmounts = BTC_15M_SHARE_AMOUNTS;
            shareWeights = BTC_15M_SHARE_WEIGHTS;
        }

        // Weighted random selection
        const totalWeight = shareWeights.reduce((a, b) => a + b, 0);
        let rand = Math.random() * totalWeight;
        for (let i = 0; i < shareAmounts.length; i++) {
            rand -= shareWeights[i];
            if (rand <= 0) {
                // Add small variance (±5%) to avoid exact matches
                const variance = 0.95 + Math.random() * 0.1;
                return shareAmounts[i] * variance;
            }
        }
        return 12; // Default fallback
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

    // ==========================================================================
    // FINAL SAFETY CHECK: Re-verify market validity right before trade execution
    // This catches race conditions where market expired during trade calculation
    // ==========================================================================
    const tradeNow = Date.now();
    if (market.endDate && market.endDate > 0) {
        const endDateMs = market.endDate < 10000000000 ? market.endDate * 1000 : market.endDate;
        if (tradeNow >= endDateMs) {
            debugLog(`buildPosition: ${market.marketKey} - ABORTED trade (market expired during calculation)`);
            return;
        }
    }

    // Also verify market is still in discoveredMarkets (may have been cleaned up)
    if (!discoveredMarkets.has(positionKey)) {
        debugLog(`buildPosition: ${market.marketKey} - ABORTED trade (market removed during calculation)`);
        return;
    }

    // ==========================================================================
    // WATCHER ARBITRAGE PATTERN (from LIVE data - Dec 28)
    // Watcher buys BOTH sides to guarantee profit:
    // - UP @ $0.09-0.12 when market UP=$0.54 (buys at BID, ~80% discount!)
    // - DOWN @ $0.87-0.91 when market DOWN=$0.47 (buys at ASK, ~85% premium!)
    // Total cost: ~$0.98, Payout: $1.00, Guaranteed profit: ~$0.02/share
    //
    // KEY INSIGHT: Watcher uses ORDERBOOK edges, not mid-market!
    // - For UP: Buy at BID (much lower than mid-market)
    // - For DOWN: Buy at ASK (much higher than mid-market, but 1-ASK_UP)
    // ==========================================================================

    // Calculate execution prices using ORDERBOOK ARBITRAGE pattern
    let execPriceUp = market.priceUp;
    let execPriceDown = market.priceDown;

    // The spread from mid to orderbook edge is typically 70-85% in these markets
    // UP: Buy at BID = mid * (1 - spread) where spread ~ 0.75-0.85
    // DOWN: Buy at ASK = 1 - (mid_up * (1 - spread)) which is high

    // UP execution: Buy at BID (massive discount from mid-market)
    // When UP mid = $0.54, BID might be $0.09-0.12 (83% discount)
    const upSpread = 0.75 + Math.random() * 0.10; // 75-85% discount
    execPriceUp = Math.max(0.02, market.priceUp * (1 - upSpread));

    // DOWN execution: Buy at ASK = 1 - BID_UP (the other side of the spread)
    // When we buy UP at $0.10, DOWN costs $0.90 (1 - 0.10)
    // This ensures total cost is ~$0.98-1.00
    const downSpread = 0.75 + Math.random() * 0.10; // Same spread
    execPriceDown = Math.min(0.98, 1 - (market.priceUp * (1 - downSpread)));

    // Ensure reasonable bounds
    execPriceUp = Math.max(0.05, Math.min(0.20, execPriceUp));
    execPriceDown = Math.max(0.80, Math.min(0.95, execPriceDown));

    // Execute UP trade (minimum 0.5 shares like watcher)
    if (sharesUp >= MIN_SHARES && tradeUp > 0 && currentCapital >= tradeUp) {
        // Recalculate trade value at execution price
        const execTradeUp = sharesUp * execPriceUp;

        // Update weighted average price using execution price
        const totalInvestedUp = buildState.investedUp + execTradeUp;
        buildState.avgPriceUp = (buildState.avgPriceUp * buildState.investedUp + execPriceUp * execTradeUp) / totalInvestedUp;

        buildState.investedUp = totalInvestedUp;
        currentCapital -= execTradeUp;
        buildState.tradeCount++;
        buildState.tradeCountUp++;  // Track UP trades separately
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
        await logPaperTrade(tempPos, 'UP', 'BUY', sharesUp, execTradeUp, execPriceUp);

        debugLog(`buildPosition: ${market.marketKey} UP trade #${buildState.tradeCount}: ${sharesUp.toFixed(1)} shares @ ${execPriceUp.toFixed(4)} = $${execTradeUp.toFixed(2)}`);
    }

    // Execute DOWN trade (minimum 0.5 shares like watcher)
    if (sharesDown >= MIN_SHARES && tradeDown > 0 && currentCapital >= tradeDown) {
        // Recalculate trade value at execution price
        const execTradeDown = sharesDown * execPriceDown;

        // Update weighted average price using execution price
        const totalInvestedDown = buildState.investedDown + execTradeDown;
        buildState.avgPriceDown = (buildState.avgPriceDown * buildState.investedDown + execPriceDown * execTradeDown) / totalInvestedDown;

        buildState.investedDown = totalInvestedDown;
        currentCapital -= execTradeDown;
        buildState.tradeCount++;
        buildState.tradeCountDown++;  // Track DOWN trades separately
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
        await logPaperTrade(tempPos, 'DOWN', 'BUY', sharesDown, execTradeDown, execPriceDown);

        debugLog(`buildPosition: ${market.marketKey} DOWN trade #${buildState.tradeCount}: ${sharesDown.toFixed(1)} shares @ ${execPriceDown.toFixed(4)} = $${execTradeDown.toFixed(2)}`);
    }

    // Set next trade time based on EXACT watcher gap distribution
    // Dec 27-28 - 57,259 trades: 72.6% at 2-3s, 13.7% at 4-5s, 8.5% at 5-10s
    // Average: 3.56s, Median: 2.00s
    // NOTE: No trades in 0-1s, 1-2s, or 3-4s - watcher uses discrete intervals
    const gapRoll = Math.random();
    let gap: number;
    if (gapRoll < 0.726) {
        gap = 2000 + Math.random() * 1000; // 2-3s (72.6%)
    } else if (gapRoll < 0.863) {
        gap = 4000 + Math.random() * 1000; // 4-5s (13.7%)
    } else if (gapRoll < 0.948) {
        gap = 5000 + Math.random() * 5000; // 5-10s (8.5%)
    } else if (gapRoll < 0.987) {
        gap = 10000 + Math.random() * 10000; // 10-20s (3.9%)
    } else {
        gap = 20000 + Math.random() * 10000; // 20s+ (1.3%)
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
    debugLog(`📊 POSITION BUILT: ${market.marketKey} | ${buildState.tradeCount} trades | UP $${buildState.investedUp.toFixed(2)} @ avg ${buildState.avgPriceUp.toFixed(4)} / DOWN $${buildState.investedDown.toFixed(2)} @ avg ${buildState.avgPriceDown.toFixed(4)} (${upPct}/${downPct})`);

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

    debugLog(`🎯 ARB: ${position.marketKey} | Bought ${loserSide} @ $${loserPrice.toFixed(4)} (${arbShares.toFixed(0)} shares for $${arbCost.toFixed(2)}) | Winner: ${winner} (${((winner === 'UP' ? priceUp : priceDown) * 100).toFixed(1)}%)`);
}

/**
 * Settle expired positions
 * Wait for clear winner (one side >= 95%) before settling
 * Timeout after 2 minutes and use higher price as winner
 */
const SETTLEMENT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes after endDate

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

        // Determine winner - need one side to reach 95%+
        let upWon = priceUp >= 0.95;
        let downWon = priceDown >= 0.95;

        // If no clear winner yet, wait or use fallback
        if (!upWon && !downWon) {
            const timeSinceEnd = now - position.endDate;

            if (timeSinceEnd < SETTLEMENT_TIMEOUT_MS) {
                // Still within timeout window - keep waiting for clear winner
                debugLog(`⏳ Waiting for clear winner: ${position.marketKey} | UP: ${(priceUp * 100).toFixed(1)}% | DOWN: ${(priceDown * 100).toFixed(1)}% | Time since end: ${Math.floor(timeSinceEnd / 1000)}s`);
                continue; // Don't settle yet
            }

            // Timeout reached - use higher price as winner
            debugLog(`⚠️ Settlement timeout: ${position.marketKey} - using higher price as winner`);
            if (priceUp > priceDown) {
                upWon = true;
            } else {
                downWon = true;
            }
        }

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
        // CRITICAL: Include BOTH asset IDs so marketTracker can fetch prices immediately
        assetUp: position.assetUp,
        assetDown: position.assetDown,
        side: action,
        outcomeIndex: side === 'UP' ? 0 : 1,
        outcome: side,
        title: position.marketName,
        slug: position.marketSlug,
        eventSlug: position.marketSlug,
        endDate: Math.floor(position.endDate / 1000),
        // CRITICAL: Pass actual market prices for accurate price difference logging
        marketPriceUp: position.currentPriceUp,
        marketPriceDown: position.currentPriceDown,
    };

    // Process through marketTracker for display
    await marketTracker.processTrade(paperActivity);

    // Log to CSV
    tradeLogger.logTrade(paperActivity, 'PAPER').catch(() => {});
}

/**
 * Display current status - informative dashboard like watcher mode
 */
function displayStatus(): void {
    const now = Date.now();
    const lines: string[] = [];

    // Get current ET time for display
    const etFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    });
    const etTime = etFormatter.format(new Date(now));

    // Header
    lines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    lines.push(chalk.cyan.bold(`  🤖 PAPER TRADING MODE                                         ${etTime} ET`));
    lines.push(chalk.gray('  Strategy: Dual-side accumulation | Mirroring watcher patterns'));
    lines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    lines.push('');

    // Filter out expired markets and only show markets that correspond to current ET time
    // Only show the 4 active markets: current BTC 15m, current ETH 15m, current BTC 1h, current ETH 1h
    // ALSO show NEXT markets when current is about to expire (for seamless transition)
    const isMarketCurrentlyActive = (marketName: string, marketKey: string, marketSlug?: string): boolean => {
        // Get current ET time
        const displayETFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
        const etParts = displayETFormatter.formatToParts(new Date(now));
        const currentHour = parseInt(etParts.find(p => p.type === 'hour')?.value || '0', 10);
        const currentMinute = parseInt(etParts.find(p => p.type === 'minute')?.value || '0', 10);
        const currentSecond = parseInt(etParts.find(p => p.type === 'second')?.value || '0', 10);

        // Check if it's a 15-minute market
        const is15Min = marketKey.includes('-15');

        if (is15Min) {
            // For 15-minute markets: extract time window (e.g., "10:00AM-10:15AM ET")
            // Current market should be: floor(currentMinute/15)*15 to floor(currentMinute/15)*15 + 15
            const current15MinStart = Math.floor(currentMinute / 15) * 15;

            // Calculate next 15-min window start
            const next15MinStart = (current15MinStart + 15) % 60;
            const nextWindowHour = current15MinStart + 15 >= 60 ? (currentHour + 1) % 24 : currentHour;

            // Check if we're within 10 seconds of window switch - if so, also show NEXT window markets
            const secondsUntilSwitch = (15 - (currentMinute % 15)) * 60 - currentSecond;
            const showNextWindow = secondsUntilSwitch <= 10 && secondsUntilSwitch >= 0;

            // First try slug format: btc-updown-15m-{unix_timestamp}
            if (marketSlug) {
                const slugTimestampMatch = marketSlug.match(/updown-15m-(\d+)/);
                if (slugTimestampMatch) {
                    const marketTimestamp = parseInt(slugTimestampMatch[1], 10) * 1000;
                    const marketDate = new Date(marketTimestamp);
                    // Convert to ET
                    const marketSlugETFormatter = new Intl.DateTimeFormat('en-US', {
                        timeZone: 'America/New_York',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                    });
                    const marketETParts = marketSlugETFormatter.formatToParts(marketDate);
                    const marketETHour = parseInt(marketETParts.find(p => p.type === 'hour')?.value || '0', 10);
                    const marketETMinute = parseInt(marketETParts.find(p => p.type === 'minute')?.value || '0', 10);
                    const marketWindow = Math.floor(marketETMinute / 15) * 15;

                    // Debug log for 15-min market matching
                    debugLog(`15m filter: ${marketKey} | slug=${marketSlug?.split('-').pop()} | currentHour=${currentHour} marketHour=${marketETHour} | currentWindow=${current15MinStart} marketWindow=${marketWindow} | secsToSwitch=${secondsUntilSwitch}`);

                    // Match current window OR next window if we're about to switch
                    const matchesCurrent = marketETHour === currentHour && marketWindow === current15MinStart;
                    const matchesNext = showNextWindow && marketETHour === nextWindowHour && marketWindow === next15MinStart;

                    return matchesCurrent || matchesNext;
                }
            }

            // Fallback: Extract time window from market name - pattern: "HH:MMAM-PM - HH:MMAM-PM" or "HH:MM - HH:MM"
            const timeWindowPattern = /(\d{1,2}):(\d{2})\s*([AP]M)?\s*[-–]\s*(\d{1,2}):(\d{2})\s*([AP]M)?/i;
            const match = marketName.match(timeWindowPattern);
            if (!match) return false;

            let startHour = parseInt(match[1], 10);
            const startMinute = parseInt(match[2], 10);
            const startAMPM = match[3]?.toUpperCase();

            // Handle AM/PM for start time
            if (startAMPM) {
                if (startAMPM === 'PM' && startHour !== 12) startHour += 12;
                if (startAMPM === 'AM' && startHour === 12) startHour = 0;
            }

            // Check if market matches current 15-minute window
            // Market should start at currentHour:current15MinStart
            return startHour === currentHour && startMinute === current15MinStart;
        } else {
            // For 1-hour markets: extract hour
            // First try slug format: bitcoin-up-or-down-december-26-10am-et
            if (marketSlug) {
                // Pattern: {month}-{day}-{hour}am|pm-et (e.g., "december-26-10am-et")
                const slugHourMatch = marketSlug.match(/(\d{1,2})(am|pm)-et$/i);
                if (slugHourMatch) {
                    let marketHour = parseInt(slugHourMatch[1], 10);
                    const ampm = slugHourMatch[2].toUpperCase();
                    if (ampm === 'PM' && marketHour !== 12) marketHour += 12;
                    if (ampm === 'AM' && marketHour === 12) marketHour = 0;
                    return marketHour === currentHour;
                }
            }

            // Fallback: Pattern from market name - number followed by optional AM/PM, followed by ET
            const hourPattern = /(\d{1,2})\s*([AP]M)?\s*ET/i;
            const match = marketName.match(hourPattern);
            if (!match) return false;

            let marketHour = parseInt(match[1], 10);
            const ampm = match[2]?.toUpperCase();

            // Handle AM/PM
            if (ampm) {
                if (ampm === 'PM' && marketHour !== 12) marketHour += 12;
                if (ampm === 'AM' && marketHour === 12) marketHour = 0;
            }

            // Check if market hour matches current hour
            return marketHour === currentHour;
        }
    };
    
    // Grace period: Keep markets visible for 60 seconds after endDate
    // This prevents trades from resetting to 0 before the new market is discovered
    const DISPLAY_GRACE_PERIOD_MS = 60 * 1000;

    const activeMarkets = Array.from(discoveredMarkets.entries()).filter(
        ([id, m]) => {
            // First filter: not expired (with grace period for display)
            if (m.endDate && m.endDate + DISPLAY_GRACE_PERIOD_MS <= now) {
                debugLog(`Filtered out ${m.marketKey}: expired beyond grace period`);
                return false;
            }

            // Second filter: must correspond to current ET time
            const isActive = isMarketCurrentlyActive(m.marketName, m.marketKey, m.marketSlug);
            if (!isActive && m.marketKey.includes('-15')) {
                debugLog(`Filtered out ${m.marketKey}: not current ET window (slug=${m.marketSlug})`);
            }
            return isActive;
        }
    );

    // Log discovered vs active counts for debugging - visible output
    const discovered15m = Array.from(discoveredMarkets.values()).filter(m => m.marketKey.includes('-15'));
    const active15m = activeMarkets.filter(([_, m]) => m.marketKey.includes('-15'));
    const discovered1h = Array.from(discoveredMarkets.values()).filter(m => m.marketKey.includes('-1h'));
    const active1h = activeMarkets.filter(([_, m]) => m.marketKey.includes('-1h'));

    // Always log counts so user can see what's happening
    lines.push(chalk.gray(`  Markets: ${discovered15m.length} 15m discovered, ${active15m.length} active | ${discovered1h.length} 1h discovered, ${active1h.length} active`));

    if (discovered15m.length > 0 && active15m.length === 0) {
        // 15m markets discovered but none active - show why
        debugLog(`⚠️ 15m filter issue: ${discovered15m.length} discovered, 0 active`);
        for (const m of discovered15m) {
            debugLog(`   - ${m.marketKey} | slug=${m.marketSlug} | endDate=${m.endDate ? new Date(m.endDate).toISOString() : 'none'}`);
        }
    }

    // Group markets by base category (BTC-UpDown-15, ETH-UpDown-15, BTC-UpDown-1h, ETH-UpDown-1h)
    // Extract base category from marketKey (e.g., "BTC-UpDown-1h-6" -> "BTC-UpDown-1h")
    const groupedMarkets = new Map<string, Array<{ id: string; market: typeof discoveredMarkets extends Map<string, infer V> ? V : never }>>();
    
    for (const [id, m] of activeMarkets) {
        // Extract base category
        let baseCategory = m.marketKey;
        if (m.marketKey.includes('-15')) {
            baseCategory = m.marketKey.split('-').slice(0, 3).join('-'); // "BTC-UpDown-15"
        } else if (m.marketKey.includes('-1h')) {
            baseCategory = m.marketKey.split('-').slice(0, 3).join('-'); // "BTC-UpDown-1h"
        }
        
        if (!groupedMarkets.has(baseCategory)) {
            groupedMarkets.set(baseCategory, []);
        }
        groupedMarkets.get(baseCategory)!.push({ id, market: m });
    }

    // Track totals for summary
    let totalInvested15m = 0, totalValue15m = 0, totalPnl15m = 0, totalTrades15m = 0;
    let totalInvested1h = 0, totalValue1h = 0, totalPnl1h = 0, totalTrades1h = 0;

    // ALWAYS show all 4 market categories - show "waiting" for missing ones
    const allCategories = ['BTC-UpDown-15', 'ETH-UpDown-15', 'BTC-UpDown-1h', 'ETH-UpDown-1h'];
    for (const cat of allCategories) {
        if (!groupedMarkets.has(cat)) {
            groupedMarkets.set(cat, []); // Empty array = waiting for market
        }
    }

    // Sort categories: 15m first, then 1h
    const sortedCategories = Array.from(groupedMarkets.entries()).sort((a, b) => {
        const aIs15 = a[0].includes('-15');
        const bIs15 = b[0].includes('-15');
        if (aIs15 && !bIs15) return -1;
        if (!aIs15 && bIs15) return 1;
        return a[0].localeCompare(b[0]);
    });

    // Display each market in watcher-style format
    for (const [baseCategory, markets] of sortedCategories) {
        // If no markets in this category, show "waiting" placeholder
        if (markets.length === 0) {
            const is15m = baseCategory.includes('-15');
            const asset = baseCategory.includes('BTC') ? 'Bitcoin' : 'Ethereum';
            const timeframe = is15m ? '15-min' : '1-hour';
            lines.push(chalk.gray(`┌─ ${baseCategory} ⏳ Waiting for new market...`));
            lines.push(chalk.yellow(`│  ${asset} Up or Down - ${timeframe} market`));
            lines.push(chalk.gray(`│  🔄 Scanning for next ${timeframe} window...`));
            lines.push(chalk.gray('└' + '─'.repeat(80)));
            lines.push('');
            continue;
        }

        for (const { id, market: m } of markets) {
            const buildState = buildingPositions.get(id);
            const position = positions.get(id);

            // Get market data
            const investedUp = buildState ? buildState.investedUp : (position?.costUp || 0);
            const investedDown = buildState ? buildState.investedDown : (position?.costDown || 0);
            const totalInvested = investedUp + investedDown;

            // Get avg prices from build state or calculate from position
            const avgPriceUp = buildState ? buildState.avgPriceUp : (position?.sharesUp ? position.costUp / position.sharesUp : 0);
            const avgPriceDown = buildState ? buildState.avgPriceDown : (position?.sharesDown ? position.costDown / position.sharesDown : 0);

            // Calculate shares from invested/avgPrice
            const sharesUp = avgPriceUp > 0 ? investedUp / avgPriceUp : (position?.sharesUp || 0);
            const sharesDown = avgPriceDown > 0 ? investedDown / avgPriceDown : (position?.sharesDown || 0);

            // Get trade counts (buildState tracks UP and DOWN separately)
            const tradesUp = buildState ? buildState.tradeCountUp : 0;
            const tradesDown = buildState ? buildState.tradeCountDown : 0;

            // Get live prices with validation (same as watcher mode)
            const liveUp = m.priceUp || 0;
            const liveDown = m.priceDown || 0;

            // Validate prices are within valid range (0 to 1) - same as watcher
            const hasValidPriceUp = liveUp > 0 && liveUp <= 1;
            const hasValidPriceDown = liveDown > 0 && liveDown <= 1;
            const hasValidPrices = hasValidPriceUp && hasValidPriceDown;

            // Calculate PnL (same logic as watcher mode - marketTracker.ts)
            // PnL = (shares × currentPrice) - costBasis
            let currentValueUp = 0;
            let currentValueDown = 0;
            let pnlUp = 0;
            let pnlDown = 0;

            if (hasValidPriceUp && sharesUp > 0) {
                currentValueUp = sharesUp * liveUp;
                pnlUp = currentValueUp - investedUp;
            }

            if (hasValidPriceDown && sharesDown > 0) {
                currentValueDown = sharesDown * liveDown;
                pnlDown = currentValueDown - investedDown;
            }

            const totalPnl = pnlUp + pnlDown;
            const totalCurrentValue = currentValueUp + currentValueDown;

            // Calculate percentages
            const upPercent = totalInvested > 0 ? (investedUp / totalInvested) * 100 : 50;
            const downPercent = totalInvested > 0 ? (investedDown / totalInvested) * 100 : 50;

            // Calculate time left - use the market's actual slug timestamp if available
            let timeLeftStr = '';
            let endDateToUse = m.endDate;

            // For 15-minute markets, calculate endDate from slug for accuracy
            if (m.marketSlug && m.marketKey.includes('-15')) {
                const slugTimestampMatch = m.marketSlug.match(/updown-15m-(\d+)/);
                if (slugTimestampMatch) {
                    const marketStartTime = parseInt(slugTimestampMatch[1], 10) * 1000;
                    const calculatedEndDate = marketStartTime + (15 * 60 * 1000);
                    // Use the calculated endDate if it makes more sense
                    if (calculatedEndDate > now && calculatedEndDate < now + (20 * 60 * 1000)) {
                        endDateToUse = calculatedEndDate;
                    }
                }
            }

            if (endDateToUse && endDateToUse > 0) {
                const endDateMs = endDateToUse < 10000000000 ? endDateToUse * 1000 : endDateToUse;
                const timeLeftMs = endDateMs - now;

                // Debug: Log if time seems wrong (> 16 mins for 15m market or > 61 mins for 1h market)
                const is15mMarket = m.marketKey.includes('-15');
                const maxTime = is15mMarket ? 16 * 60 * 1000 : 61 * 60 * 1000;
                if (timeLeftMs > maxTime) {
                    debugLog(`⚠️ TIME BUG: ${m.marketKey} shows ${Math.floor(timeLeftMs/60000)}m left! endDate=${m.endDate}, calculated=${endDateToUse}, now=${now}, slug=${m.marketSlug}`);
                }

                if (timeLeftMs > 0) {
                    const mins = Math.floor(timeLeftMs / 60000);
                    const secs = Math.floor((timeLeftMs % 60000) / 1000);
                    timeLeftStr = `⏱️ ${mins}m ${secs}s left`;
                } else {
                    timeLeftStr = '⌛ Expired';
                }
            }

            // Track totals by market type
            const is15m = m.marketKey.includes('-15');
            if (is15m) {
                totalInvested15m += totalInvested;
                totalValue15m += totalCurrentValue;
                totalPnl15m += hasValidPrices ? totalPnl : 0;
                totalTrades15m += tradesUp + tradesDown;
            } else {
                totalInvested1h += totalInvested;
                totalValue1h += totalCurrentValue;
                totalPnl1h += hasValidPrices ? totalPnl : 0;
                totalTrades1h += tradesUp + tradesDown;
            }

            // Market header
            lines.push(chalk.yellow(`┌─ ${m.marketKey} ${timeLeftStr}`));
            lines.push(chalk.gray(`│  ${m.marketName.slice(0, 65)}`));

            // UP line
            const upLiveStr = hasValidPrices ? chalk.yellow.bold(`LIVE: $${liveUp.toFixed(4)}`) : chalk.gray('LIVE: fetching...');
            const upPnlColor = pnlUp >= 0 ? chalk.green : chalk.red;
            const upPnlStr = hasValidPrices ? upPnlColor(`${pnlUp >= 0 ? '+' : ''}$${pnlUp.toFixed(2)} (${investedUp > 0 ? ((pnlUp/investedUp)*100).toFixed(1) : '0.0'}%)`) : '';
            lines.push(chalk.gray(`│  `) + chalk.green('📈 UP:   ') + chalk.white(`${sharesUp.toFixed(2)} shares | $${investedUp.toFixed(2)} @ $${avgPriceUp.toFixed(4)} avg | `) + upLiveStr + chalk.white(' | ') + upPnlStr + chalk.gray(` | ${tradesUp} trades`));

            // DOWN line
            const downLiveStr = hasValidPrices ? chalk.yellow.bold(`LIVE: $${liveDown.toFixed(4)}`) : chalk.gray('LIVE: fetching...');
            const downPnlColor = pnlDown >= 0 ? chalk.green : chalk.red;
            const downPnlStr = hasValidPrices ? downPnlColor(`${pnlDown >= 0 ? '+' : ''}$${pnlDown.toFixed(2)} (${investedDown > 0 ? ((pnlDown/investedDown)*100).toFixed(1) : '0.0'}%)`) : '';
            lines.push(chalk.gray(`│  `) + chalk.red('📉 DOWN: ') + chalk.white(`${sharesDown.toFixed(2)} shares | $${investedDown.toFixed(2)} @ $${avgPriceDown.toFixed(4)} avg | `) + downLiveStr + chalk.white(' | ') + downPnlStr + chalk.gray(` | ${tradesDown} trades`));

            // Live price sum check
            if (hasValidPrices) {
                const liveSum = liveUp + liveDown;
                const sumStatus = Math.abs(liveSum - 1.0) < 0.02 ? chalk.green('✓') : chalk.yellow('⚠️');
                lines.push(chalk.gray(`│  💵 Live Prices: UP $${liveUp.toFixed(4)} + DOWN $${liveDown.toFixed(4)} = $${liveSum.toFixed(4)} `) + sumStatus);
            }

            // Summary line with PnL
            const pnlSign = totalPnl >= 0 ? '+' : '';
            const pnlPct = totalInvested > 0 ? ((totalPnl / totalInvested) * 100).toFixed(1) : '0.0';
            const totalPnlColor = totalPnl >= 0 ? chalk.green : chalk.red;
            if (hasValidPrices) {
                lines.push(chalk.gray(`│  💰 Invested: $${totalInvested.toFixed(2)} | Value: $${totalCurrentValue.toFixed(2)} | PnL: `) + totalPnlColor(`${pnlSign}$${totalPnl.toFixed(2)} (${pnlSign}${pnlPct}%)`));
            } else {
                lines.push(chalk.gray(`│  💰 Total Invested: $${totalInvested.toFixed(2)} | ${tradesUp + tradesDown} trades`));
            }

            // Visual bar - colorful like watcher mode
            const barLength = 40;
            const upBars = Math.round((upPercent / 100) * barLength);
            const downBars = barLength - upBars;
            const upBar = chalk.green('█'.repeat(upBars));
            const downBar = chalk.red('█'.repeat(downBars));
            lines.push(chalk.gray(`│  [`) + upBar + downBar + chalk.gray(`] `) + chalk.green(`${upPercent.toFixed(1)}% UP`) + chalk.gray(' / ') + chalk.red(`${downPercent.toFixed(1)}% DOWN`));
            lines.push(chalk.yellow('└' + '─'.repeat(80)));
            lines.push('');
        }
    }

    // Portfolio Summary Section
    lines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    lines.push(chalk.cyan.bold('  📊 PORTFOLIO SUMMARY'));

    // 15-minute markets summary
    const pnl15mSign = totalPnl15m >= 0 ? '+' : '';
    const pnl15mPct = totalInvested15m > 0 ? ((totalPnl15m / totalInvested15m) * 100).toFixed(2) : '0.00';
    const pnl15mColor = totalPnl15m >= 0 ? chalk.green : chalk.red;
    lines.push('');
    lines.push(chalk.white.bold('  ⏱️  15-Minute Markets (BTC + ETH)'));
    lines.push(chalk.gray(`    Invested: $${totalInvested15m.toFixed(2)} | Value: $${totalValue15m.toFixed(2)} | PnL: `) + pnl15mColor(`${pnl15mSign}$${totalPnl15m.toFixed(2)} (${pnl15mSign}${pnl15mPct}%)`) + chalk.gray(` | Trades: ${totalTrades15m}`));

    // 1-hour markets summary
    const pnl1hSign = totalPnl1h >= 0 ? '+' : '';
    const pnl1hPct = totalInvested1h > 0 ? ((totalPnl1h / totalInvested1h) * 100).toFixed(2) : '0.00';
    const pnl1hColor = totalPnl1h >= 0 ? chalk.green : chalk.red;
    lines.push('');
    lines.push(chalk.white.bold('  🕐 1-Hour Markets (BTC + ETH)'));
    lines.push(chalk.gray(`    Invested: $${totalInvested1h.toFixed(2)} | Value: $${totalValue1h.toFixed(2)} | PnL: `) + pnl1hColor(`${pnl1hSign}$${totalPnl1h.toFixed(2)} (${pnl1hSign}${pnl1hPct}%)`) + chalk.gray(` | Trades: ${totalTrades1h}`));

    // Total summary
    const totalInvestedAll = totalInvested15m + totalInvested1h;
    const totalValueAll = totalValue15m + totalValue1h;
    const totalPnlAll = totalPnl15m + totalPnl1h;
    const totalTradesAll = totalTrades15m + totalTrades1h;
    const totalPnlSign = totalPnlAll >= 0 ? '+' : '';
    const totalPnlPct = totalInvestedAll > 0 ? ((totalPnlAll / totalInvestedAll) * 100).toFixed(2) : '0.00';
    const totalPnlAllColor = totalPnlAll >= 0 ? chalk.green : chalk.red;

    lines.push('');
    lines.push(chalk.yellow.bold('  📈 TOTAL (All Markets)'));
    lines.push(chalk.white(`    Capital: $${currentCapital.toFixed(2)} | Invested: $${totalInvestedAll.toFixed(2)} | Value: $${totalValueAll.toFixed(2)}`));
    lines.push(chalk.gray('    PnL: ') + totalPnlAllColor.bold(`${totalPnlSign}$${totalPnlAll.toFixed(2)} (${totalPnlSign}${totalPnlPct}%)`) + chalk.gray(` | Total Trades: ${totalTradesAll}`));

    // Realized PnL from settled positions
    if (totalPnL !== 0) {
        const realizedSign = totalPnL >= 0 ? '+' : '';
        const realizedColor = totalPnL >= 0 ? chalk.green : chalk.red;
        lines.push(chalk.gray('    Realized PnL (from settled): ') + realizedColor(`${realizedSign}$${totalPnL.toFixed(2)}`));
    }

    lines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

    // ==========================================================================
    // UPCOMING MARKETS MINI DASHBOARD - Show what's being tracked/fetched
    // ==========================================================================
    lines.push('');
    lines.push(chalk.magenta.bold('  🔮 UPCOMING MARKETS'));

    // Get current ET window info
    const upcomingETFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const upcomingETParts = upcomingETFormatter.formatToParts(new Date(now));
    const upcomingHour = parseInt(upcomingETParts.find(p => p.type === 'hour')?.value || '0', 10);
    const upcomingMinute = parseInt(upcomingETParts.find(p => p.type === 'minute')?.value || '0', 10);
    const current15MinWindow = Math.floor(upcomingMinute / 15) * 15;
    const next15MinWindow = (current15MinWindow + 15) % 60;
    const nextWindowHour = current15MinWindow + 15 >= 60 ? (upcomingHour + 1) % 24 : upcomingHour;

    // Format times
    const formatTime = (h: number, m: number) => {
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return `${h12}:${m.toString().padStart(2, '0')}${ampm}`;
    };

    const currentWindowStr = `${formatTime(upcomingHour, current15MinWindow)}-${formatTime(nextWindowHour, next15MinWindow)}`;
    const nextHourStr = upcomingHour < 12 ? `${upcomingHour + 1}AM` : upcomingHour === 11 ? '12PM' : upcomingHour === 23 ? '12AM' : `${upcomingHour - 11}PM`;

    // Check what markets we have discovered
    const hasBTC15m = Array.from(discoveredMarkets.values()).some(m => m.marketKey === 'BTC-UpDown-15' && m.endDate && m.endDate > now);
    const hasETH15m = Array.from(discoveredMarkets.values()).some(m => m.marketKey === 'ETH-UpDown-15' && m.endDate && m.endDate > now);
    const hasBTC1h = Array.from(discoveredMarkets.values()).some(m => m.marketKey.startsWith('BTC-UpDown-1h') && m.endDate && m.endDate > now);
    const hasETH1h = Array.from(discoveredMarkets.values()).some(m => m.marketKey.startsWith('ETH-UpDown-1h') && m.endDate && m.endDate > now);

    // Calculate seconds until next 15-min window
    const secsToNext15m = (15 - (upcomingMinute % 15)) * 60 - new Date(now).getSeconds();
    const secsToNextHour = (60 - upcomingMinute) * 60 - new Date(now).getSeconds();

    lines.push('');
    lines.push(chalk.gray('    Current Window: ') + chalk.white(currentWindowStr) + chalk.gray(' ET'));
    lines.push('');

    // 15-min status
    const btc15mStatus = hasBTC15m ? chalk.green('✓ READY') : chalk.yellow('⏳ Fetching...');
    const eth15mStatus = hasETH15m ? chalk.green('✓ READY') : chalk.yellow('⏳ Fetching...');
    lines.push(chalk.gray('    15-Min: ') + chalk.cyan('BTC ') + btc15mStatus + chalk.gray(' | ') + chalk.cyan('ETH ') + eth15mStatus + chalk.gray(` | Next in ${secsToNext15m}s`));

    // 1h status
    const btc1hStatus = hasBTC1h ? chalk.green('✓ READY') : chalk.yellow('⏳ Fetching...');
    const eth1hStatus = hasETH1h ? chalk.green('✓ READY') : chalk.yellow('⏳ Fetching...');
    lines.push(chalk.gray('    1-Hour: ') + chalk.cyan('BTC ') + btc1hStatus + chalk.gray(' | ') + chalk.cyan('ETH ') + eth1hStatus + chalk.gray(` | Next: ${nextHourStr} ET`));

    // Show discovered market slugs for debugging
    const slugs15m = Array.from(discoveredMarkets.values())
        .filter(m => m.marketKey.includes('-15'))
        .map(m => {
            const ts = m.marketSlug?.match(/updown-15m-(\d+)/)?.[1];
            const isBTC = m.marketKey.includes('BTC');
            return ts ? `${isBTC ? 'B' : 'E'}:${ts?.slice(-4)}` : null;
        })
        .filter(Boolean);

    if (slugs15m.length > 0) {
        lines.push(chalk.gray(`    Tracked: `) + chalk.dim(slugs15m.join(' | ')));
    }

    lines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    lines.push('');

    // Clear screen completely and move cursor to top
    // \x1b[2J = clear entire screen, \x1b[3J = clear scrollback, \x1b[H = move cursor to top-left
    // \x1b[0J = clear from cursor to end of screen (prevents leftover text)
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

    // Pad each line to 82 chars to prevent overlap from previous longer lines
    const paddedLines = lines.map(line => {
        // Strip ANSI codes to get visual length
        const visualLength = line.replace(/\x1b\[[0-9;]*m/g, '').length;
        const padding = Math.max(0, 82 - visualLength);
        return line + ' '.repeat(padding);
    });

    process.stdout.write(paddedLines.join('\n') + '\n');

    // Clear any remaining lines below (in case previous output was longer)
    process.stdout.write('\x1b[0J');
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
    const DISPLAY_INTERVAL_MS = 1000; // Refresh dashboard every 1s
    const CLEANUP_INTERVAL_MS = 30000; // Clean up expired markets every 30 seconds
    let loopCount = 0;

    // Do initial cleanup
    Logger.info('🧹 Cleaning up any expired markets...');
    await cleanupExpiredMarketsAndPositions();

    // Start a separate fast price update loop (runs in parallel with main loop)
    const FAST_PRICE_UPDATE_MS = 1; // Update prices every 50ms - maximum speed
    let priceUpdateRunning = true;
    const fastPriceUpdateLoop = async () => {
        while (priceUpdateRunning && isRunning) {
            try {
                await updatePrices();
            } catch (e) {
                // Silent fail - don't let price updates crash the bot
            }
            await new Promise(resolve => setTimeout(resolve, FAST_PRICE_UPDATE_MS));
        }
    };
    // Start the fast price update loop (don't await - runs in background)
    fastPriceUpdateLoop();

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

            // PROACTIVE DISCOVERY - Find markets directly without waiting for watcher
            await proactivelyDiscoverMarkets();

            // Discover markets from watched traders (still useful for syncing state)
            await discoverMarketsFromWatchers();

            // Log discoveredMarkets status after sync
            if (discoveredMarkets.size === 0 && marketTracker.getMarkets().size > 0) {
                debugLog(`⚠️ discoveredMarkets is still empty after sync! marketTracker has ${marketTracker.getMarkets().size} markets`);
            } else if (discoveredMarkets.size > 0) {
                debugLog(`✓ discoveredMarkets has ${discoveredMarkets.size} markets`);
            }

            // NOTE: Price updates now run in a separate fast loop (every 250ms)
            // No need to call updatePrices() here - it runs in parallel

            // Process each discovered market
            debugLog(`Processing ${discoveredMarkets.size} discovered markets...`);
            for (const [conditionId, market] of discoveredMarkets.entries()) {
                // Only skip if endDate is set AND has passed
                // If endDate is 0/undefined, we still process the market
                // CRITICAL: Handle both seconds and milliseconds format
                if (market.endDate && market.endDate > 0) {
                    const endDateMs = market.endDate < 10000000000 ? market.endDate * 1000 : market.endDate;
                    if (endDateMs <= now) {
                        debugLog(`  SKIP ${market.marketKey}: expired (endDate ${new Date(endDateMs).toISOString()} <= now)`);
                        // CRITICAL: Also remove expired market from discoveredMarkets and clean up position
                        const buildState = buildingPositions.get(conditionId);
                        if (buildState && buildState.investedUp > 0 && buildState.investedDown > 0 && !positions.has(conditionId)) {
                            // Finalize before cleanup
                            await finalizePosition(market, buildState);
                        }
                        buildingPositions.delete(conditionId);
                        discoveredMarkets.delete(conditionId);
                        continue;
                    }
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

            // Settle expired positions
            await settlePositions();

            // Display status periodically - displayStatus() handles screen clearing internally
            if (now - lastDisplayTime >= DISPLAY_INTERVAL_MS) {
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

    // Stop the fast price update loop
    priceUpdateRunning = false;

    displayStatus();
    Logger.info('Paper trade monitor stopped');
};

export default paperTradeMonitor;
