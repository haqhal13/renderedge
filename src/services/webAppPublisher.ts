import axios from 'axios';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import { AppStateSnapshot, emitStateSnapshot, subscribeToState } from './appState';
import watchlistManager from './watchlistManager';

const MIN_INTERVAL_MS = parseInt(process.env.WEBAPP_PUSH_INTERVAL_MS || '2000', 10);
let lastPushedAt = 0;
let pendingTimer: NodeJS.Timeout | null = null;
let isInitialized = false;

const formatUsd = (value?: number | null): string | undefined => {
    if (value === undefined || value === null || Number.isNaN(value)) {
        return undefined;
    }
    return `$${value.toFixed(2)}`;
};

const mapTrades = (trades: AppStateSnapshot['trades'] = []) =>
    trades.map((trade) => {
        const timestampMs = trade.timestamp || Date.now();
        const marketUrl = trade.marketSlug
            ? `https://polymarket.com/event/${trade.marketSlug}`
            : trade.marketName || '';
        return {
            trader: trade.traderAddress,
            action: trade.side,
            asset: trade.asset || trade.marketSlug || trade.marketName,
            side: trade.side,
            amount: formatUsd(trade.usdcSize),
            price: trade.price,
            market: marketUrl,
            tx: trade.transactionHash ? `https://polygonscan.com/tx/${trade.transactionHash}` : undefined,
            timestamp: timestampMs,
        };
    });

const mapTraders = (traders: AppStateSnapshot['traders'] = []) => {
    const watchlistEntries = watchlistManager.getAllAddresses();
    return traders.map((trader) => {
        const watchEntry = watchlistEntries.find(
            (w) => w.address.toLowerCase() === trader.address.toLowerCase()
        );
        return {
            address: trader.address,
            alias: watchEntry?.alias,
            enabled: watchEntry?.enabled ?? true,
            notes: trader.positionCount ? `${trader.positionCount} positions` : undefined,
        };
    });
};

const mapWatchlist = () =>
    watchlistManager.getAllAddresses().map((entry) => ({
        address: entry.address,
        alias: entry.alias,
        enabled: entry.enabled,
        addedAt: entry.addedAt,
    }));

const mapPortfolio = (snapshot: AppStateSnapshot) => {
    const portfolio = snapshot.myPortfolio;
    const balance = portfolio?.availableCash ?? 0;
    const invested = portfolio?.investedValue ?? 0;
    const totalValue = (portfolio?.currentValue ?? 0) + balance;
    const pnl = totalValue - invested;

    return {
        balance,
        totalInvested: invested,
        totalPnL: pnl,
        totalTrades: snapshot.trades?.length ?? 0,
    };
};

const mapPnlHistory = (pnlHistory: AppStateSnapshot['pnlHistory'] = []) =>
    pnlHistory.map((entry) => ({
        marketName: entry.marketName,
        conditionId: entry.conditionId || '',
        totalPnl: entry.totalPnL,
        pnlPercent: entry.pnlPercent,
        outcome: entry.outcome,
        timestamp: entry.timestamp,
        marketType: entry.marketType,
    }));

const mapMarketSummaries = (markets: AppStateSnapshot['marketSummaries'] = []) =>
    markets.map((m) => ({
        marketKey: m.marketKey,
        marketName: m.marketName,
        category: m.category,
        endDate: m.endDate,
        timeRemaining: m.timeRemaining,
        isExpired: m.isExpired,
        priceUp: m.priceUp,
        priceDown: m.priceDown,
        sharesUp: m.sharesUp,
        sharesDown: m.sharesDown,
        investedUp: m.investedUp,
        investedDown: m.investedDown,
        currentValueUp: m.currentValueUp,
        currentValueDown: m.currentValueDown,
        pnlUp: m.pnlUp,
        pnlDown: m.pnlDown,
        pnlUpPercent: m.pnlUpPercent,
        pnlDownPercent: m.pnlDownPercent,
        totalPnL: m.totalPnL,
        totalPnLPercent: m.totalPnLPercent,
        tradesUp: m.tradesUp,
        tradesDown: m.tradesDown,
        upPercent: m.upPercent,
        downPercent: m.downPercent,
    }));

const buildPayload = (snapshot: AppStateSnapshot) => ({
    botName: process.env.BOT_NAME || 'EdgeBotPro',
    updatedAt: snapshot.updatedAt,
    myPortfolio: mapPortfolio(snapshot),
    traders: mapTraders(snapshot.traders),
    trades: mapTrades(snapshot.trades),
    executions: snapshot.executions ?? [],
    health: snapshot.health ?? {},
    watchlist: mapWatchlist(),
    watchlistCount: watchlistManager.getCount(),
    // Add pnlHistory and marketSummaries for dashboard display
    pnlHistory: mapPnlHistory(snapshot.pnlHistory),
    marketSummaries: mapMarketSummaries(snapshot.marketSummaries),
});

const sendPayload = async (reason: string, snapshot: AppStateSnapshot): Promise<void> => {
    const url = ENV.WEBAPP_PUSH_URL;
    if (!url) {
        return;
    }

    lastPushedAt = Date.now();
    pendingTimer = null;

    try {
        const botId = process.env.BOT_ID || 'watcher';
        await axios.post(
            url,
            {
                botId,
                reason,
                runtimeMode: snapshot.mode,
                payload: buildPayload(snapshot),
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    ...(ENV.WEBAPP_API_KEY ? { Authorization: `Bearer ${ENV.WEBAPP_API_KEY}` } : {}),
                },
                timeout: ENV.WEBAPP_PUSH_TIMEOUT_MS,
            }
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.warning(`Failed to push update to web app: ${message}`);
    }
};

export const publishAppState = (reason: string): void => {
    const snapshot = emitStateSnapshot(reason);

    if (!ENV.WEBAPP_PUSH_URL) {
        return;
    }

    const now = Date.now();
    const elapsed = now - lastPushedAt;

    if (elapsed >= MIN_INTERVAL_MS) {
        void sendPayload(reason, snapshot);
        return;
    }

    if (pendingTimer) {
        return;
    }

    pendingTimer = setTimeout(() => {
        const debouncedSnapshot = emitStateSnapshot(`${reason}-debounced`);
        void sendPayload(`${reason}-debounced`, debouncedSnapshot);
    }, MIN_INTERVAL_MS - elapsed);
};

/**
 * Initialize the web app publisher to automatically push updates
 * when state changes. Call this once at startup.
 */
export const initWebAppPublisher = (): void => {
    if (isInitialized) {
        return;
    }

    if (!ENV.WEBAPP_PUSH_URL) {
        Logger.info('Web app publisher not configured (no WEBAPP_PUSH_URL)');
        return;
    }

    Logger.info(`Web app publisher initialized, pushing to ${ENV.WEBAPP_PUSH_URL}`);
    isInitialized = true;

    // Subscribe to state changes and push updates
    subscribeToState((snapshot, reason) => {
        const now = Date.now();
        const elapsed = now - lastPushedAt;

        if (elapsed >= MIN_INTERVAL_MS) {
            void sendPayload(reason, snapshot);
            return;
        }

        if (pendingTimer) {
            return;
        }

        pendingTimer = setTimeout(() => {
            const debouncedSnapshot = emitStateSnapshot(`${reason}-debounced`);
            void sendPayload(`${reason}-debounced`, debouncedSnapshot);
        }, MIN_INTERVAL_MS - elapsed);
    });

    // Send initial state
    const initialSnapshot = emitStateSnapshot('init');
    void sendPayload('init', initialSnapshot);
};

export default publishAppState;
