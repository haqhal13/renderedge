import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import marketTracker from './marketTracker';
import tradeLogger from './tradeLogger';
import watchlistManager from './watchlistManager';

const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

// Get initial addresses from watchlist manager (which loads from watchlist.json, wallet file, or env)
let USER_ADDRESSES = watchlistManager.getActiveAddresses();

// Fallback to ENV if watchlist is empty
if (USER_ADDRESSES.length === 0) {
    USER_ADDRESSES = ENV.USER_ADDRESSES;
}

if (!USER_ADDRESSES || USER_ADDRESSES.length === 0) {
    throw new Error('USER_ADDRESSES is not defined or empty. Add addresses to watchlist.json or wallet file.');
}

// Cache for user models (created on demand)
const userModelsCache = new Map<string, {
    address: string;
    UserActivity: ReturnType<typeof getUserActivityModel>;
    UserPosition: ReturnType<typeof getUserPositionModel>;
}>();

// Get or create models for an address
const getModelsForAddress = (address: string) => {
    const normalized = address.toLowerCase();
    if (!userModelsCache.has(normalized)) {
        userModelsCache.set(normalized, {
            address: normalized,
            UserActivity: getUserActivityModel(normalized),
            UserPosition: getUserPositionModel(normalized),
        });
    }
    return userModelsCache.get(normalized)!;
};

// Initialize models for current addresses
USER_ADDRESSES.forEach(addr => getModelsForAddress(addr));

// Listen for watchlist changes
watchlistManager.onChange((newAddresses) => {
    USER_ADDRESSES = newAddresses;
    // Initialize models for any new addresses
    newAddresses.forEach(addr => getModelsForAddress(addr));
    Logger.info(`Watchlist updated: now monitoring ${newAddresses.length} address(es)`);
});

const init = async () => {
    // Check if MongoDB is connected
    const isMongoConnected = mongoose.connection.readyState === 1;

    if (isMongoConnected) {
        const counts: number[] = [];
        for (const address of USER_ADDRESSES) {
            const { UserActivity } = getModelsForAddress(address);
            const count = await UserActivity.countDocuments();
            counts.push(count);
        }
        Logger.clearLine();
        Logger.dbConnection(USER_ADDRESSES, counts);
    } else {
        Logger.clearLine();
        Logger.info('Running in memory-only mode (MongoDB not connected)');
        Logger.info('Trades will be logged to console and files only');
    }

    // Show your own positions first (skip in track-only mode)
    if (!ENV.TRACK_ONLY_MODE && ENV.PROXY_WALLET) {
        try {
            const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
            const myPositions = await fetchData(myPositionsUrl);

            // Get current USDC balance
            const getMyBalance = (await import('../utils/getMyBalance')).default;
            const currentBalance = await getMyBalance(ENV.PROXY_WALLET);

            if (Array.isArray(myPositions) && myPositions.length > 0) {
                // Calculate your overall profitability and initial investment
                let totalValue = 0;
                let initialValue = 0;
                let weightedPnl = 0;
                myPositions.forEach((pos: any) => {
                    const value = pos.currentValue || 0;
                    const initial = pos.initialValue || 0;
                    const pnl = pos.percentPnl || 0;
                    totalValue += value;
                    initialValue += initial;
                    weightedPnl += value * pnl;
                });
                const myOverallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;

                // Get top 5 positions by profitability (PnL)
                const myTopPositions = myPositions
                    .sort((a: any, b: any) => (b.percentPnl || 0) - (a.percentPnl || 0))
                    .slice(0, 5);

                Logger.clearLine();
                Logger.myPositions(
                    ENV.PROXY_WALLET,
                    myPositions.length,
                    myTopPositions,
                    myOverallPnl,
                    totalValue,
                    initialValue,
                    currentBalance
                );
            } else {
                Logger.clearLine();
                Logger.myPositions(ENV.PROXY_WALLET, 0, [], 0, 0, 0, currentBalance);
            }
        } catch (error) {
            Logger.error(`Failed to fetch your positions: ${error}`);
        }
    }

    // Show current positions count with details for traders you're copying (only if MongoDB connected)
    const positionCounts: number[] = [];
    const positionDetails: any[][] = [];
    const profitabilities: number[] = [];

    if (isMongoConnected) {
        for (const address of USER_ADDRESSES) {
            const { UserPosition } = getModelsForAddress(address);
            const positions = await UserPosition.find().exec();
            positionCounts.push(positions.length);

            // Calculate overall profitability (weighted average by current value)
            let totalValue = 0;
            let weightedPnl = 0;
            positions.forEach((pos) => {
                const value = pos.currentValue || 0;
                const pnl = pos.percentPnl || 0;
                totalValue += value;
                weightedPnl += value * pnl;
            });
            const overallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;
            profitabilities.push(overallPnl);

            // Get top 3 positions by profitability (PnL)
            const topPositions = positions
                .sort((a, b) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 3)
                .map((p) => p.toObject());
            positionDetails.push(topPositions);
        }
        Logger.clearLine();
        Logger.tradersPositions(USER_ADDRESSES, positionCounts, positionDetails, profitabilities);
    } else {
        // In memory-only mode, just show we're tracking
        Logger.clearLine();
        Logger.info(`Tracking ${USER_ADDRESSES.length} trader(s) - trades will be logged to console`);
    }
};

// Track processed trades in memory when MongoDB is not available
const processedTrades = new Set<string>();

const fetchTradeData = async () => {
    // Use a more lenient cutoff for watch mode - allow trades from last 48 hours
    // This ensures we catch new markets even if there's a slight delay
    const watchModeCutoffHours = ENV.TRACK_ONLY_MODE ? 48 : TOO_OLD_TIMESTAMP;
    const cutoffSeconds = Math.floor(Date.now() / 1000) - watchModeCutoffHours * 60 * 60;
    // Also allow any trade from the last 5 minutes regardless of cutoff (catches new hourly markets)
    const recentCutoffSeconds = Math.floor(Date.now() / 1000) - (5 * 60);

    const isMongoConnected = mongoose.connection.readyState === 1;

    // Get current addresses from watchlist (may have changed since last fetch)
    const currentAddresses = watchlistManager.getActiveAddresses();
    if (currentAddresses.length === 0) {
        return; // No addresses to monitor
    }

    for (const address of currentAddresses) {
        const { UserActivity, UserPosition } = getModelsForAddress(address);
        try {
            // Fetch trade activities from Polymarket API
            const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE&limit=200`;
            const activities = await fetchData(apiUrl);

            if (!Array.isArray(activities) || activities.length === 0) {
                continue;
            }

            // Process each activity
            for (const activity of activities) {
                // Allow trades from last 5 minutes OR within the normal cutoff window
                // This ensures we catch new hourly markets even if timestamp is slightly off
                const isRecent = activity.timestamp >= recentCutoffSeconds;
                const isWithinWindow = activity.timestamp >= cutoffSeconds;
                
                if (!isRecent && !isWithinWindow) {
                    continue; // Skip if too old
                }

                // Verify this trade belongs to the watched wallet
                // Check if activity has proxyWallet field and it matches, or if user field matches
                if (activity.proxyWallet && activity.proxyWallet.toLowerCase() !== address.toLowerCase()) {
                    // Trade might be from a different wallet, skip it
                    continue;
                }
                if (activity.user && activity.user.toLowerCase() !== address.toLowerCase()) {
                    // Trade user doesn't match, skip it
                    continue;
                }

                const tradeKey = `${address}:${activity.transactionHash}`;
                
                if (isMongoConnected) {
                    // Check if this trade already exists in database
                    const existingActivity = await UserActivity.findOne({
                        transactionHash: activity.transactionHash,
                    }).exec();

                    if (existingActivity) {
                        continue; // Already processed this trade
                    }

                    // Save new trade to database
                    const newActivity = new UserActivity({
                        proxyWallet: activity.proxyWallet,
                        timestamp: activity.timestamp,
                        conditionId: activity.conditionId,
                        type: activity.type,
                        size: activity.size,
                        usdcSize: activity.usdcSize,
                        transactionHash: activity.transactionHash,
                        price: activity.price,
                        asset: activity.asset,
                        side: activity.side,
                        outcomeIndex: activity.outcomeIndex,
                        title: activity.title,
                        slug: activity.slug,
                        icon: activity.icon,
                        eventSlug: activity.eventSlug,
                        outcome: activity.outcome,
                        name: activity.name,
                        pseudonym: activity.pseudonym,
                        bio: activity.bio,
                        profileImage: activity.profileImage,
                        profileImageOptimized: activity.profileImageOptimized,
                        bot: false,
                        botExcutedTime: 0,
                    });

                    await newActivity.save();
                } else {
                    // Memory-only mode: check if we've seen this trade
                    if (processedTrades.has(tradeKey)) {
                        continue; // Already processed
                    }
                    processedTrades.add(tradeKey);
                }
                
                // Fetch FRESH prices from CLOB API at the moment of trade
                // This gets the ACTUAL orderbook prices for both UP and DOWN - no calculation
                const freshPrices = await marketTracker.fetchFreshPricesBySlug(activity.slug || '');
                if (freshPrices) {
                    // Inject fresh API prices into activity for accurate logging
                    activity.marketPriceUp = freshPrices.priceUp;
                    activity.marketPriceDown = freshPrices.priceDown;
                    // Only log prices in non-watcher mode (verbose logging clutters dashboard)
                    if (!ENV.TRACK_ONLY_MODE) {
                        console.log(`📊 FRESH API PRICES: UP=$${freshPrices.priceUp.toFixed(4)} DOWN=$${freshPrices.priceDown.toFixed(4)}`);
                    }
                } else {
                    // Fallback to cached prices if fresh fetch fails
                    const cachedPrices = marketTracker.getLivePricesBySlug(activity.slug || '');
                    if (cachedPrices) {
                        activity.marketPriceUp = cachedPrices.priceUp;
                        activity.marketPriceDown = cachedPrices.priceDown;
                        // Only log prices in non-watcher mode
                        if (!ENV.TRACK_ONLY_MODE) {
                            console.log(`📊 CACHED PRICES: UP=$${cachedPrices.priceUp.toFixed(4)} DOWN=$${cachedPrices.priceDown.toFixed(4)}`);
                        }
                    }
                }

                // Log trade with detailed information (including market prices)
                tradeLogger.logTrade(activity, address).catch((error) => {
                    Logger.error(`Error logging trade: ${error}`);
                });
                
                // Process trade through market tracker (for both modes)
                // Note: processTrade is now async, but we don't await to avoid blocking
                marketTracker.processTrade(activity).catch((error) => {
                    Logger.error(`Error processing trade in market tracker: ${error}`);
                });
            }

            // Also fetch and update positions (only if MongoDB is connected)
            if (isMongoConnected) {
                const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
                const positions = await fetchData(positionsUrl);

                if (Array.isArray(positions) && positions.length > 0) {
                    for (const position of positions) {
                        // Update or create position
                        await UserPosition.findOneAndUpdate(
                            { asset: position.asset, conditionId: position.conditionId },
                            {
                                proxyWallet: position.proxyWallet,
                                asset: position.asset,
                                conditionId: position.conditionId,
                                size: position.size,
                                avgPrice: position.avgPrice,
                                initialValue: position.initialValue,
                                currentValue: position.currentValue,
                                cashPnl: position.cashPnl,
                                percentPnl: position.percentPnl,
                                totalBought: position.totalBought,
                                realizedPnl: position.realizedPnl,
                                percentRealizedPnl: position.percentRealizedPnl,
                                curPrice: position.curPrice,
                                redeemable: position.redeemable,
                                mergeable: position.mergeable,
                                title: position.title,
                                slug: position.slug,
                                icon: position.icon,
                                eventSlug: position.eventSlug,
                                outcome: position.outcome,
                                outcomeIndex: position.outcomeIndex,
                                oppositeOutcome: position.oppositeOutcome,
                                oppositeAsset: position.oppositeAsset,
                                endDate: position.endDate,
                                negativeRisk: position.negativeRisk,
                            },
                            { upsert: true }
                        );
                    }
                }
            }
        } catch (error) {
            Logger.error(
                `Error fetching data for ${address.slice(0, 6)}...${address.slice(-4)}: ${error}`
            );
        }
    }
};

// Track if this is the first run
let isFirstRun = true;
// Track if monitor should continue running
let isRunning = true;

/**
 * Stop the trade monitor gracefully
 */
export const stopTradeMonitor = () => {
    isRunning = false;
    Logger.info('Trade monitor shutdown requested...');
};

const tradeMonitor = async () => {
    await init();
    Logger.success(`Monitoring ${USER_ADDRESSES.length} trader(s) every ${FETCH_INTERVAL}s`);
    Logger.separator();

    // On first run, mark all existing historical trades as already processed (only if MongoDB connected)
    if (isFirstRun) {
        const isMongoConnected = mongoose.connection.readyState === 1;
        if (isMongoConnected) {
            Logger.info('First run: marking all historical trades as processed...');
            for (const address of USER_ADDRESSES) {
                const { UserActivity } = getModelsForAddress(address);
                const count = await UserActivity.updateMany(
                    { bot: false },
                    { $set: { bot: true, botExcutedTime: 999 } }
                );
                if (count.modifiedCount > 0) {
                    Logger.info(
                        `Marked ${count.modifiedCount} historical trades as processed for ${address.slice(0, 6)}...${address.slice(-4)}`
                    );
                }
            }
            Logger.success('\nHistorical trades processed. Now monitoring for new trades only.');
        } else {
            Logger.info('First run: starting fresh (no historical data in memory-only mode)');
        }
        isFirstRun = false;
        Logger.separator();
    }

    while (isRunning) {
        // Proactively discover 15-min markets (ensures they appear on dashboard immediately)
        await marketTracker.proactivelyDiscover15MinMarkets();

        await fetchTradeData();

        // Display market stats periodically
        await marketTracker.displayStats();
        
        if (!isRunning) break;
        // Use faster polling for watch mode to catch new markets quickly
        const pollInterval = ENV.TRACK_ONLY_MODE ? Math.min(FETCH_INTERVAL, 2) : FETCH_INTERVAL;
        await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));
    }

    Logger.info('Trade monitor stopped');
};

export default tradeMonitor;
