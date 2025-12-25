import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import { MarketStats } from './marketTracker';

const RETRY_LIMIT = ENV.RETRY_LIMIT || 3;
const MIN_SELL_TOKENS = 1.0; // Minimum tokens to sell
const ZERO_THRESHOLD = 0.0001;

interface Position {
    conditionId: string;
    asset: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    title?: string;
    slug?: string;
    outcome?: string;
}

interface SellResult {
    soldTokens: number;
    proceedsUsd: number;
    remainingTokens: number;
}

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) {
        return undefined;
    }

    if (typeof response === 'string') {
        return response;
    }

    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;

        const directError = data.error;
        if (typeof directError === 'string') {
            return directError;
        }

        if (typeof directError === 'object' && directError !== null) {
            const nested = directError as Record<string, unknown>;
            if (typeof nested.error === 'string') {
                return nested.error;
            }
            if (typeof nested.message === 'string') {
                return nested.message;
            }
        }

        if (typeof data.errorMsg === 'string') {
            return data.errorMsg;
        }

        if (typeof data.message === 'string') {
            return data.message;
        }
    }

    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message: string | undefined): boolean => {
    if (!message) {
        return false;
    }
    const lower = message.toLowerCase();
    return lower.includes('not enough balance') || lower.includes('allowance');
};

const updatePolymarketCache = async (clobClient: ClobClient, tokenId: string): Promise<void> => {
    try {
        await clobClient.getOrderBook(tokenId);
    } catch (error) {
        Logger.warning(`⚠️  Failed to refresh balance cache for ${tokenId}: ${error}`);
    }
};

const sellEntirePosition = async (
    clobClient: ClobClient,
    position: Position
): Promise<SellResult> => {
    let remaining = position.size;
    let attempts = 0;
    let soldTokens = 0;
    let proceedsUsd = 0;

    if (remaining < MIN_SELL_TOKENS) {
        Logger.info(
            `   ⚠️  Position size ${remaining.toFixed(4)} < ${MIN_SELL_TOKENS} token minimum, skipping`
        );
        return { soldTokens: 0, proceedsUsd: 0, remainingTokens: remaining };
    }

    await updatePolymarketCache(clobClient, position.asset);

    while (remaining >= MIN_SELL_TOKENS && attempts < RETRY_LIMIT) {
        const orderBook = await clobClient.getOrderBook(position.asset);

        if (!orderBook.bids || orderBook.bids.length === 0) {
            Logger.warning('   ⚠️  Order book has no bids – liquidity unavailable');
            break;
        }

        const bestBid = orderBook.bids.reduce((max, bid) => {
            return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
        }, orderBook.bids[0]);

        const bidSize = parseFloat(bestBid.size);
        const bidPrice = parseFloat(bestBid.price);

        if (bidSize < MIN_SELL_TOKENS) {
            Logger.warning(
                `   ⚠️  Best bid only for ${bidSize.toFixed(2)} tokens (< ${MIN_SELL_TOKENS})`
            );
            break;
        }

        const sellAmount = Math.min(remaining, bidSize);

        if (sellAmount < MIN_SELL_TOKENS) {
            Logger.warning(`   ⚠️  Remaining amount ${sellAmount.toFixed(4)} below minimum sell size`);
            break;
        }

        const orderArgs = {
            side: Side.SELL,
            tokenID: position.asset,
            amount: sellAmount,
            price: bidPrice,
        };

        try {
            const signedOrder = await clobClient.createMarketOrder(orderArgs);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success === true) {
                const tradeValue = sellAmount * bidPrice;
                soldTokens += sellAmount;
                proceedsUsd += tradeValue;
                remaining -= sellAmount;
                attempts = 0;
                Logger.info(
                    `   ✅ Sold ${sellAmount.toFixed(2)} tokens @ $${bidPrice.toFixed(3)} (≈ $${tradeValue.toFixed(2)})`
                );
            } else {
                attempts += 1;
                const errorMessage = extractOrderError(resp);

                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    Logger.warning(
                        `   ❌ Order rejected: ${errorMessage ?? 'balance/allowance issue'}`
                    );
                    break;
                }
                Logger.warning(
                    `   ⚠️  Sell attempt ${attempts}/${RETRY_LIMIT} failed${errorMessage ? ` – ${errorMessage}` : ''}`
                );
            }
        } catch (error) {
            attempts += 1;
            Logger.warning(`   ⚠️  Sell attempt ${attempts}/${RETRY_LIMIT} threw error: ${error}`);
        }
    }

    if (remaining >= MIN_SELL_TOKENS) {
        Logger.warning(`   ⚠️  Remaining unsold: ${remaining.toFixed(2)} tokens`);
    } else if (remaining > 0) {
        Logger.info(
            `   ℹ️  Residual dust < ${MIN_SELL_TOKENS} token left (${remaining.toFixed(4)})`
        );
    }

    return { soldTokens, proceedsUsd, remainingTokens: remaining };
};

const loadPositions = async (address: string): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${address}`;
    const data = await fetchData(url);
    const positions = Array.isArray(data) ? (data as Position[]) : [];
    return positions.filter((pos) => (pos.size || 0) > ZERO_THRESHOLD);
};

/**
 * Close positions for a market that is being switched out
 */
export const closeMarketPositions = async (
    clobClient: ClobClient | null,
    market: MarketStats
): Promise<void> => {
    if (!clobClient) {
        Logger.info(`   ℹ️  No CLOB client available, skipping position close for ${market.marketKey}`);
        return;
    }

    if (ENV.TRACK_ONLY_MODE || !ENV.PROXY_WALLET) {
        Logger.info(`   ℹ️  Track-only mode or no proxy wallet, skipping position close for ${market.marketKey}`);
        return;
    }

    try {
        Logger.info(`🔄 Closing positions for market: ${market.marketKey}`);
        Logger.info(`   Market: ${market.marketName}`);

        const myPositions = await loadPositions(ENV.PROXY_WALLET);

        // Find positions matching this market's conditionId and assets
        const positionsToClose: Position[] = [];
        
        if (market.conditionId) {
            // Match by conditionId
            const matchingByCondition = myPositions.filter(
                (pos) => pos.conditionId === market.conditionId
            );
            positionsToClose.push(...matchingByCondition);
        }

        // Also match by asset IDs if available
        if (market.assetUp) {
            const matchingByAssetUp = myPositions.filter(
                (pos) => pos.asset === market.assetUp && !positionsToClose.includes(pos)
            );
            positionsToClose.push(...matchingByAssetUp);
        }

        if (market.assetDown) {
            const matchingByAssetDown = myPositions.filter(
                (pos) => pos.asset === market.assetDown && !positionsToClose.includes(pos)
            );
            positionsToClose.push(...matchingByAssetDown);
        }

        if (positionsToClose.length === 0) {
            Logger.info(`   ℹ️  No positions found to close for ${market.marketKey}`);
            return;
        }

        Logger.info(`   Found ${positionsToClose.length} position(s) to close`);

        let totalTokens = 0;
        let totalProceeds = 0;

        for (let i = 0; i < positionsToClose.length; i++) {
            const position = positionsToClose[i];
            Logger.info(
                `   ${i + 1}/${positionsToClose.length} - ${position.title || position.slug || position.asset}`
            );
            Logger.info(
                `      Size: ${position.size.toFixed(2)} tokens @ $${position.avgPrice.toFixed(3)}`
            );

            try {
                const result = await sellEntirePosition(clobClient, position);
                totalTokens += result.soldTokens;
                totalProceeds += result.proceedsUsd;
            } catch (error) {
                Logger.error(`   ❌ Failed to close position: ${error}`);
            }
        }

        Logger.success(
            `✅ Closed ${positionsToClose.length} position(s): ${totalTokens.toFixed(2)} tokens, $${totalProceeds.toFixed(2)} USDC`
        );
    } catch (error) {
        Logger.error(`❌ Error closing positions for market ${market.marketKey}: ${error}`);
    }
};

