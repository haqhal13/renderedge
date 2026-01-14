import Logger from '../utils/logger';
import fetchData from '../utils/fetchData';
import { MarketSummary, PnlHistoryEntry } from './appState';

interface PolymarketPosition {
    proxyWallet: string;
    conditionId: string;
    asset: string;
    size: number;
    avgPrice: number;
    curPrice: number;
    initialValue: number;
    currentValue: number;
    cashPnl: number;
    percentPnl: number;
    outcome: string;
    title: string;
    slug: string;
    endDate: string;
}

interface PolymarketTrade {
    id: string;
    timestamp: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    outcome: string;
    market: string;
    asset: string;
    conditionId: string;
}

export interface WalletAnalyticsResult {
    portfolio: {
        balance: number;
        totalInvested: number;
        totalPnL: number;
        totalPnLPercent: number;
        totalTrades: number;
        pnl15m: number;
        pnl15mPercent: number;
        trades15m: number;
        pnl1h: number;
        pnl1hPercent: number;
        trades1h: number;
        pnl5m: number;
        pnl5mPercent: number;
        trades5m: number;
    };
    markets: MarketSummary[];
    pnlHistory: PnlHistoryEntry[];
}

interface MarketGroup {
    conditionId: string;
    marketName: string;
    endDate: number;
    category: string;
    up?: PolymarketPosition;
    down?: PolymarketPosition;
}

const parseCategory = (marketName: string): string => {
    const lower = marketName.toLowerCase();
    if (lower.includes('btc') || lower.includes('bitcoin')) return 'BTC';
    if (lower.includes('eth') || lower.includes('ethereum')) return 'ETH';
    return 'OTHER';
};

const detectMarketType = (marketName: string): '5m' | '15m' | '1h' | 'OTHER' => {
    const lower = marketName.toLowerCase();
    if (lower.includes('5m') || lower.includes('5-min')) return '5m';
    if (lower.includes('15') || lower.includes(':15') || lower.includes(':30') || lower.includes(':45')) return '15m';
    if (lower.includes('1h') || /\b1\s?hour\b/i.test(marketName) || /\d{1,2}(am|pm)/i.test(marketName)) return '1h';
    return 'OTHER';
};

const formatTimeRemaining = (endDate: number): { timeRemaining: string; isExpired: boolean } => {
    if (!endDate) {
        return { timeRemaining: 'Unknown', isExpired: false };
    }
    const now = Date.now();
    const diff = endDate - now;
    if (diff <= 0) {
        return { timeRemaining: 'Expired', isExpired: true };
    }
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return { timeRemaining: `${mins}m ${secs.toString().padStart(2, '0')}s`, isExpired: false };
};

const groupPositionsByMarket = (positions: PolymarketPosition[]): Map<string, MarketGroup> => {
    const map = new Map<string, MarketGroup>();
    for (const pos of positions) {
        const existing = map.get(pos.conditionId) || {
            conditionId: pos.conditionId,
            marketName: pos.title,
            endDate: pos.endDate ? new Date(pos.endDate).getTime() : 0,
            category: parseCategory(pos.title),
        };
        if (pos.outcome?.toLowerCase().includes('up')) {
            existing.up = pos;
        } else {
            existing.down = pos;
        }
        map.set(pos.conditionId, existing);
    }
    return map;
};

const calculatePortfolioBuckets = (marketType: '5m' | '15m' | '1h' | 'OTHER',
    marketCost: number,
    marketPnL: number,
    buckets: Record<'5m' | '15m' | '1h', { pnl: number; invested: number; trades: number }>,
    upPosition?: PolymarketPosition,
    downPosition?: PolymarketPosition) => {
    const trades = (upPosition ? 1 : 0) + (downPosition ? 1 : 0);
    if (marketType === '5m') {
        buckets['5m'].pnl += marketPnL;
        buckets['5m'].invested += marketCost;
        buckets['5m'].trades += trades;
    } else if (marketType === '15m' || marketType === 'OTHER') {
        buckets['15m'].pnl += marketPnL;
        buckets['15m'].invested += marketCost;
        buckets['15m'].trades += trades;
    } else if (marketType === '1h') {
        buckets['1h'].pnl += marketPnL;
        buckets['1h'].invested += marketCost;
        buckets['1h'].trades += trades;
    }
};

const buildMarketSummary = (group: MarketGroup): MarketSummary => {
    const up = group.up;
    const down = group.down;
    const totalCostUp = up?.initialValue || 0;
    const totalCostDown = down?.initialValue || 0;
    const investedUp = totalCostUp;
    const investedDown = totalCostDown;
    const currentValueUp = up?.currentValue || 0;
    const currentValueDown = down?.currentValue || 0;
    const pnlUp = up?.cashPnl || 0;
    const pnlDown = down?.cashPnl || 0;
    const marketCost = totalCostUp + totalCostDown;
    const totalPnL = pnlUp + pnlDown;
    const { timeRemaining, isExpired } = formatTimeRemaining(group.endDate);

    return {
        marketKey: group.conditionId,
        marketName: group.marketName,
        category: group.category,
        endDate: group.endDate,
        timeRemaining,
        isExpired,
        priceUp: up?.curPrice || 0,
        priceDown: down?.curPrice || 0,
        sharesUp: up?.size || 0,
        sharesDown: down?.size || 0,
        investedUp,
        investedDown,
        currentValueUp,
        currentValueDown,
        pnlUp,
        pnlDown,
        pnlUpPercent: investedUp > 0 ? (pnlUp / investedUp) * 100 : 0,
        pnlDownPercent: investedDown > 0 ? (pnlDown / investedDown) * 100 : 0,
        totalPnL,
        totalPnLPercent: marketCost > 0 ? (totalPnL / marketCost) * 100 : 0,
        tradesUp: up ? 1 : 0,
        tradesDown: down ? 1 : 0,
        upPercent: marketCost > 0 ? (investedUp / marketCost) * 100 : 50,
        downPercent: marketCost > 0 ? (investedDown / marketCost) * 100 : 50,
    };
};

const buildPnlHistory = (markets: MarketSummary[]): PnlHistoryEntry[] => {
    const now = Date.now();
    const entries: PnlHistoryEntry[] = [];

    for (const market of markets) {
        if (!market.isExpired || market.totalPnL === 0) continue;
        const marketType = detectMarketType(market.marketName);
        const timeExpired = market.endDate ? now - market.endDate : 0;
        const maxStale = 60 * 60 * 1000;
        if (timeExpired > maxStale) continue;

        const outcome: 'UP' | 'DOWN' = market.priceDown > market.priceUp ? 'DOWN' : 'UP';
        entries.push({
            marketName: market.marketName,
            totalPnL: market.totalPnL,
            pnlPercent: market.totalPnLPercent,
            outcome,
            timestamp: market.endDate || now,
            marketType,
            conditionId: market.marketKey,
        });
    }

    return entries.sort((a, b) => b.timestamp - a.timestamp);
};

export const getWalletAnalytics = async (address?: string): Promise<WalletAnalyticsResult | null> => {
    if (!address) {
        return null;
    }
    const normalizedAddress = address.toLowerCase();

    try {
        const [positionsRaw, tradesRaw] = await Promise.all([
            fetchData(`https://data-api.polymarket.com/positions?user=${normalizedAddress}`).catch(() => []),
            fetchData(`https://data-api.polymarket.com/trades?user=${normalizedAddress}&limit=200`).catch(() => []),
        ]);

        const positions: PolymarketPosition[] = Array.isArray(positionsRaw) ? positionsRaw : [];
        const trades: PolymarketTrade[] = Array.isArray(tradesRaw) ? tradesRaw : [];

        const grouped = groupPositionsByMarket(positions);
        const markets: MarketSummary[] = [];
        let totalInvested = 0;
        let totalPnL = 0;
        const buckets = {
            '5m': { pnl: 0, invested: 0, trades: 0 },
            '15m': { pnl: 0, invested: 0, trades: 0 },
            '1h': { pnl: 0, invested: 0, trades: 0 },
        } as const;

        for (const group of grouped.values()) {
            const summary = buildMarketSummary(group);
            totalInvested += summary.investedUp + summary.investedDown;
            totalPnL += summary.totalPnL;
            const marketType = detectMarketType(summary.marketName);
            calculatePortfolioBuckets(
                marketType,
                summary.investedUp + summary.investedDown,
                summary.totalPnL,
                buckets,
                group.up,
                group.down
            );
            markets.push(summary);
        }

        const balanceEstimate = markets.reduce((acc, market) => acc + market.currentValueUp + market.currentValueDown, 0);
        const pnlHistory = buildPnlHistory(markets);
        const activeMarkets = markets.filter((m) => !m.isExpired);

        return {
            portfolio: {
                balance: balanceEstimate,
                totalInvested,
                totalPnL,
                totalPnLPercent: totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0,
                totalTrades: trades.length,
                pnl15m: buckets['15m'].pnl,
                pnl15mPercent: buckets['15m'].invested > 0 ? (buckets['15m'].pnl / buckets['15m'].invested) * 100 : 0,
                trades15m: buckets['15m'].trades,
                pnl1h: buckets['1h'].pnl,
                pnl1hPercent: buckets['1h'].invested > 0 ? (buckets['1h'].pnl / buckets['1h'].invested) * 100 : 0,
                trades1h: buckets['1h'].trades,
                pnl5m: buckets['5m'].pnl,
                pnl5mPercent: buckets['5m'].invested > 0 ? (buckets['5m'].pnl / buckets['5m'].invested) * 100 : 0,
                trades5m: buckets['5m'].trades,
            },
            markets: activeMarkets,
            pnlHistory,
        };
    } catch (error) {
        Logger.warning(`Failed to compute wallet analytics for ${address}: ${error}`);
        return null;
    }
};
