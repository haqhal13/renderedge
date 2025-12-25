/**
 * Paper Trade Monitor
 * 
 * 1:1 with watcher mode - uses same marketTracker, same market discovery, same price fetching.
 * Only difference: adds independent trading logic on top.
 */

import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import marketTracker from './marketTracker';
import tradeLogger from './tradeLogger';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;

if (!USER_ADDRESSES || USER_ADDRESSES.length === 0) {
    throw new Error('USER_ADDRESSES is not defined or empty');
}

// Track processed trades in memory (same as watcher mode)
const processedTrades = new Set<string>();

interface WatcherMarketStats {
    conditionId: string;
    marketKey: string;
    marketName: string;
    marketSlug?: string;
    investedUp: number;
    investedDown: number;
    tradesUp: number;
    tradesDown: number;
    lastTradeTime: number;
}

// Track watcher allocations per market (keyed by conditionId)
const watcherMarketStats = new Map<string, WatcherMarketStats>();

// Paper trading state
let isRunning = true;
let startingCapital = parseFloat(process.env.PAPER_STARTING_CAPITAL || '1000.0');
let currentCapital = startingCapital;

// Independent strategy parameters (paper mode does NOT copy trades directly)
const PAPER_MAX_PER_MARKET = parseFloat(process.env.PAPER_MAX_PER_MARKET || '200');
const PAPER_MIN_TRADE = parseFloat(process.env.PAPER_MIN_TRADE || '5');
const PAPER_MAX_TRADE = parseFloat(process.env.PAPER_MAX_TRADE || '50');
const PAPER_MIN_ALLOCATION = parseFloat(process.env.PAPER_MIN_ALLOCATION || '20'); // %
const PAPER_MAX_ALLOCATION = parseFloat(process.env.PAPER_MAX_ALLOCATION || '80'); // %

/**
 * Determine if outcome is UP or DOWN for a watcher trade
 */
const isUpOutcome = (activity: any): boolean => {
    if (activity.outcomeIndex !== undefined) {
        return activity.outcomeIndex === 0;
    }

    const outcome = (activity.outcome || '').toLowerCase();
    const asset = (activity.asset || '').toLowerCase();

    if (
        outcome.includes('up') ||
        outcome.includes('higher') ||
        outcome.includes('above') ||
        outcome.includes('yes') ||
        asset.includes('yes') ||
        asset.includes('up')
    ) {
        return true;
    }

    if (
        outcome.includes('down') ||
        outcome.includes('lower') ||
        outcome.includes('below') ||
        outcome.includes('no') ||
        asset.includes('no') ||
        asset.includes('down')
    ) {
        return false;
    }

    return true;
};

/**
 * Update watcher allocation snapshot for a single activity
 */
const updateWatcherMarketStatsFromActivity = (activity: any): void => {
    const conditionId = activity.conditionId;
    if (!conditionId) {
        return;
    }

    const side = (activity.side || 'BUY').toUpperCase();
    const up = isUpOutcome(activity);
    const usdcSize = parseFloat(activity.usdcSize || '0');

    if (!usdcSize || usdcSize <= 0) {
        return;
    }

    let stats = watcherMarketStats.get(conditionId);

    if (!stats) {
        // Try to pull normalized market data from marketTracker if available
        const trackerMarket = marketTracker.getMarketByConditionId(conditionId);
        const marketKey = trackerMarket?.marketKey || activity.slug || conditionId;
        const marketName =
            trackerMarket?.marketName || activity.title || activity.slug || 'Unknown Market';
        const marketSlug = trackerMarket?.marketSlug || activity.slug || '';

        stats = {
            conditionId,
            marketKey,
            marketName,
            marketSlug,
            investedUp: 0,
            investedDown: 0,
            tradesUp: 0,
            tradesDown: 0,
            lastTradeTime: activity.timestamp || Math.floor(Date.now() / 1000),
        };
        watcherMarketStats.set(conditionId, stats);
    }

    // BUY increases exposure, SELL decreases exposure on the corresponding side
    const signedAmount = side === 'SELL' ? -usdcSize : usdcSize;

    if (up) {
        stats.investedUp += signedAmount;
        stats.tradesUp += 1;
    } else {
        stats.investedDown += signedAmount;
        stats.tradesDown += 1;
    }

    stats.lastTradeTime = activity.timestamp || Math.floor(Date.now() / 1000);
};

/**
 * Discover markets by fetching trades from USER_ADDRESSES (same as watcher mode)
 * We use watcher trades ONLY to:
 *   1) discover which markets exist (via marketTracker.processTrade)
 *
 * Paper mode NEVER copies individual trades directly – it runs its own strategy.
 */
const discoverMarkets = async (): Promise<Set<string>> => {
    const watchModeCutoffHours = 48; // Same as watcher mode
    const cutoffSeconds = Math.floor(Date.now() / 1000) - watchModeCutoffHours * 60 * 60;
    const recentCutoffSeconds = Math.floor(Date.now() / 1000) - (5 * 60);

    const discoveredConditionIds = new Set<string>();

    for (const address of USER_ADDRESSES) {
        try {
            const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE&limit=200`;
            const activities = await fetchData(apiUrl);

            if (!Array.isArray(activities) || activities.length === 0) {
                continue;
            }

            for (const activity of activities) {
                const isRecent = activity.timestamp >= recentCutoffSeconds;
                const isWithinWindow = activity.timestamp >= cutoffSeconds;
                
                if (!isRecent && !isWithinWindow) {
                    continue;
                }

                // Verify this trade belongs to the watched wallet
                if (activity.proxyWallet && activity.proxyWallet.toLowerCase() !== address.toLowerCase()) {
                    continue;
                }
                if (activity.user && activity.user.toLowerCase() !== address.toLowerCase()) {
                    continue;
                }

                const tradeKey = `${address}:${activity.transactionHash || activity.timestamp}:${activity.asset}`;
                if (processedTrades.has(tradeKey)) {
                    continue;
                }
                processedTrades.add(tradeKey);

                // Use watcher trades ONLY to discover markets (extract conditionId)
                // Paper mode trades independently using its own strategy
                if (activity.conditionId) {
                    discoveredConditionIds.add(activity.conditionId);
                    
                    // Register market structure (in PAPER mode this does not add watcher positions)
                    // This only discovers the market and updates prices, but does NOT add positions
                    await marketTracker.processTrade(activity).catch((error) => {
                        Logger.error(`Error processing trade for market discovery: ${error}`);
                    });
                    
                    // NOTE: We do NOT call simulateCopyTradeFromWatcher() - paper mode trades independently
                    // NOTE: We do NOT call updateWatcherMarketStatsFromActivity() - not needed for independent trading
                }
            }
        } catch (error) {
            Logger.error(`Error fetching data for ${address.slice(0, 6)}...${address.slice(-4)}: ${error}`);
        }
    }

    return discoveredConditionIds;
};

/**
 * Execute a paper trade by creating a fake activity and processing it through marketTracker
 */
const executePaperTrade = async (
    market: any,
    side: 'UP' | 'DOWN',
    investment: number,
    price: number
): Promise<void> => {
    if (currentCapital < investment) {
        return; // Not enough capital
    }

    const asset = side === 'UP' ? market.assetUp : market.assetDown;
    if (!asset) {
        return;
    }

    const shares = investment / price;
    // Calculate actual cost to ensure usdcSize matches cost exactly (avoids rounding issues)
    const actualCost = shares * price;

    // Create fake activity object (same format as real trades)
    const fakeActivity = {
        transactionHash: `paper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Math.floor(Date.now() / 1000),
        conditionId: market.conditionId,
        type: 'TRADE',
        size: shares.toString(),
        usdcSize: actualCost.toString(), // Use actual cost to match shares * price exactly
        price: price.toString(),
        asset: asset,
        side: 'BUY',
        outcomeIndex: side === 'UP' ? 0 : 1,
        outcome: side,
        title: market.marketName,
        slug: market.marketSlug || '',
        eventSlug: market.marketSlug || '',
        endDate: market.endDate ? Math.floor(market.endDate / 1000) : undefined,
    };

    // Process through marketTracker (same as watcher mode)
    await marketTracker.processTrade(fakeActivity);

    // Log trade
    tradeLogger.logTrade(fakeActivity, 'PAPER').catch((error) => {
        Logger.error(`Error logging paper trade: ${error}`);
    });

    // Deduct capital
    currentCapital -= investment;
};

/**
 * Make trading decisions based on current markets
 */
const makeTradingDecisions = async (): Promise<void> => {
    const markets = marketTracker.getMarkets();
    
    if (markets.size === 0) {
        return; // No markets to trade
    }

    // NOTE: This allocation-based strategy is currently unused in pure copy mode.
    // It is kept for future experimentation but NOT called from the main loop.
    const minAllocationPercent = parseFloat(process.env.PAPER_MIN_ALLOCATION || '20');
    const maxAllocationPercent = parseFloat(process.env.PAPER_MAX_ALLOCATION || '80');
    const maxCapitalPerMarket = parseFloat(process.env.PAPER_MAX_PER_MARKET || '200');
    const minTradeSize = parseFloat(process.env.PAPER_MIN_TRADE || '5');
    const maxTradeSize = parseFloat(process.env.PAPER_MAX_TRADE || '50');

    for (const [marketKey, market] of markets) {
        // Skip if market doesn't have prices yet
        if (!market.currentPriceUp || !market.currentPriceDown) {
            continue;
        }

        const priceUp = market.currentPriceUp;
        const priceDown = market.currentPriceDown;

        // Base probabilities from current prices
        const totalPrice = priceUp + priceDown;
        const probUp = priceUp / totalPrice;
        const probDown = priceDown / totalPrice;

        // Default target allocation from probabilities
        let targetAllocUp = Math.max(
            minAllocationPercent / 100,
            Math.min(maxAllocationPercent / 100, probUp)
        );
        let targetAllocDown = Math.max(
            minAllocationPercent / 100,
            Math.min(maxAllocationPercent / 100, probDown)
        );

        // Paper mode uses its own strategy based on probabilities, NOT watcher allocations
        // Watcher stats are tracked for informational purposes only, not for copying trades

        // Calculate current allocation
        const totalInvested = market.investedUp + market.investedDown;
        const currentAllocUp = totalInvested > 0 ? market.investedUp / totalInvested : 0;
        const currentAllocDown = totalInvested > 0 ? market.investedDown / totalInvested : 0;

        // Calculate how much more we can invest in this market
        // Paper mode uses its own budget limits, independent of watcher exposure
        const alreadyInvested = totalInvested;
        const targetBudget = maxCapitalPerMarket; // Use fixed budget, not scaled by watcher

        const remainingBudget = Math.max(0, targetBudget - alreadyInvested);

        if (remainingBudget < minTradeSize) {
            continue; // Already at max or can't afford minimum trade
        }

        // Rebalance if needed
        const allocDiffUp = targetAllocUp - currentAllocUp;
        const allocDiffDown = targetAllocDown - currentAllocDown;

        // Trade UP if we need more UP allocation
        if (allocDiffUp > 0.05 && currentCapital >= minTradeSize) {
            const tradeSize = Math.min(
                maxTradeSize,
                Math.max(minTradeSize, remainingBudget * allocDiffUp)
            );
            const actualTradeSize = Math.min(tradeSize, currentCapital);
            
            if (actualTradeSize >= minTradeSize) {
                await executePaperTrade(market, 'UP', actualTradeSize, priceUp);
            }
        }

        // Trade DOWN if we need more DOWN allocation
        if (allocDiffDown > 0.05 && currentCapital >= minTradeSize) {
            const tradeSize = Math.min(
                maxTradeSize,
                Math.max(minTradeSize, remainingBudget * allocDiffDown)
            );
            const actualTradeSize = Math.min(tradeSize, currentCapital);
            
            if (actualTradeSize >= minTradeSize) {
                await executePaperTrade(market, 'DOWN', actualTradeSize, priceDown);
            }
        }
    }
};

/**
 * Stop the paper trade monitor gracefully
 */
export const stopPaperTradeMonitor = () => {
    isRunning = false;
    Logger.info('Paper trade monitor shutdown requested...');
};

/**
 * Paper trade monitor - 1:1 with watcher mode
 */
const paperTradeMonitor = async () => {
    Logger.success('Paper trading mode: Independent trading (1:1 with watcher mode)');
    Logger.separator();

    // Set market tracker to PAPER mode for correct header display
    marketTracker.setDisplayMode('PAPER');

    while (isRunning) {
        try {
            // Discover markets (same as watcher mode) - only extracts market info, does NOT copy trades
            await discoverMarkets();
            
            // Make independent trading decisions based on paper mode's own strategy
            await makeTradingDecisions();
            
            // Display stats (same as watcher mode - uses same marketTracker and PAPER positions)
            await marketTracker.displayStats();
            
            if (!isRunning) break;
            
            // Same polling interval as watcher mode
            const pollInterval = Math.min(FETCH_INTERVAL, 2);
            await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));
        } catch (error) {
            Logger.error(`Error in paper trade monitor: ${error}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    Logger.info('Paper trade monitor stopped');
};

export default paperTradeMonitor;
