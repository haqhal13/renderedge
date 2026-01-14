import { HealthCheckResult } from '../utils/healthCheck';
import { WatchedAddress } from './watchlistManager';

export interface TradeEventPayload {
    traderAddress: string;
    traderDisplay?: string;
    transactionHash: string;
    conditionId?: string;
    marketName?: string;
    marketSlug?: string;
    side?: string;
    outcome?: string;
    asset?: string;
    price?: number;
    usdcSize?: number;
    timestamp: number;
    mode: 'WATCH' | 'TRADING';
}

export interface ExecutionEventPayload extends TradeEventPayload {
    executionStatus: 'FILLED' | 'FAILED';
    details?: string;
}

export interface PositionSnapshot {
    address: string;
    positionCount: number;
    profitability?: number;
    topPositions?: Array<{
        title?: string;
        outcome?: string;
        currentValue?: number;
        percentPnl?: number;
    }>;
}

export interface PortfolioSnapshot {
    wallet: string;
    openPositions: number;
    investedValue: number;
    currentValue: number;
    availableCash: number;
    overallPnl: number;
    totalPnL?: number;
    totalPnLPercent?: number;
    totalTrades?: number;
    pnl15m?: number;
    pnl15mPercent?: number;
    trades15m?: number;
    pnl1h?: number;
    pnl1hPercent?: number;
    trades1h?: number;
    pnl5m?: number;
    pnl5mPercent?: number;
    trades5m?: number;
    updatedAt: number;
}

export interface MarketSummary {
    marketKey: string;
    marketName: string;
    category: string;
    endDate?: number;
    timeRemaining: string;
    isExpired: boolean;
    priceUp: number;
    priceDown: number;
    sharesUp: number;
    sharesDown: number;
    investedUp: number;
    investedDown: number;
    currentValueUp: number;
    currentValueDown: number;
    pnlUp: number;
    pnlDown: number;
    pnlUpPercent: number;
    pnlDownPercent: number;
    totalPnL: number;
    totalPnLPercent: number;
    tradesUp: number;
    tradesDown: number;
    upPercent: number;
    downPercent: number;
}

export interface PnlHistoryEntry {
    marketName: string;
    totalPnL: number;
    pnlPercent: number;
    outcome: 'UP' | 'DOWN';
    timestamp: number;
    marketType: '5m' | '15m' | '1h' | 'OTHER';
    conditionId: string;
}

export interface AppStateSnapshot {
    mode: 'TRACK_ONLY' | 'TRADING';
    running: boolean;
    status: string;
    traders: PositionSnapshot[];
    trades: TradeEventPayload[];
    executions: ExecutionEventPayload[];
    myPortfolio?: PortfolioSnapshot;
    marketSummaries?: MarketSummary[];
    pnlHistory?: PnlHistoryEntry[];
    watchlist?: WatchedAddress[];
    health?: HealthCheckResult;
    updatedAt: number;
}

const MAX_EVENTS = 100;

const state: AppStateSnapshot = {
    mode: 'TRACK_ONLY',
    running: false,
    status: 'booting',
    traders: [],
    trades: [],
    executions: [],
    marketSummaries: [],
    pnlHistory: [],
    watchlist: [],
    updatedAt: Date.now(),
};

const updateTimestamp = () => {
    state.updatedAt = Date.now();
};

const trimList = <T>(items: T[]): T[] => {
    if (items.length <= MAX_EVENTS) {
        return items;
    }
    return items.slice(items.length - MAX_EVENTS);
};

export const setRuntimeMode = (mode: 'TRACK_ONLY' | 'TRADING'): void => {
    state.mode = mode;
    updateTimestamp();
};

export const markRunning = (running: boolean): void => {
    state.running = running;
    updateTimestamp();
};

export const setStatusMessage = (status: string): void => {
    state.status = status;
    updateTimestamp();
};

export const recordTradeEvent = (payload: TradeEventPayload): void => {
    state.trades = trimList([...state.trades, payload]);
    updateTimestamp();
};

export const recordExecutionEvent = (payload: ExecutionEventPayload): void => {
    state.executions = trimList([...state.executions, payload]);
    updateTimestamp();
};

export const setTraderSnapshots = (snapshots: PositionSnapshot[]): void => {
    state.traders = snapshots;
    updateTimestamp();
};

export const setPortfolioSnapshot = (snapshot: PortfolioSnapshot | null | undefined): void => {
    state.myPortfolio = snapshot ?? undefined;
    updateTimestamp();
};

export const setHealthSnapshot = (snapshot: HealthCheckResult): void => {
    state.health = snapshot;
    updateTimestamp();
};

export const setMarketSummaries = (markets: MarketSummary[]): void => {
    state.marketSummaries = markets;
    updateTimestamp();
};

export const setPnlHistory = (entries: PnlHistoryEntry[]): void => {
    state.pnlHistory = entries;
    updateTimestamp();
};

export const setWatchlist = (entries: WatchedAddress[]): void => {
    state.watchlist = entries;
    updateTimestamp();
};

export const getSnapshot = (): AppStateSnapshot => ({
    ...state,
    traders: state.traders.map((s) => ({ ...s, topPositions: s.topPositions?.map((p) => ({ ...p })) })),
    trades: state.trades.map((trade) => ({ ...trade })),
    executions: state.executions.map((exec) => ({ ...exec })),
    myPortfolio: state.myPortfolio ? { ...state.myPortfolio } : undefined,
    marketSummaries: state.marketSummaries ? state.marketSummaries.map((m) => ({ ...m })) : undefined,
    pnlHistory: state.pnlHistory ? state.pnlHistory.map((p) => ({ ...p })) : undefined,
    watchlist: state.watchlist ? state.watchlist.map((w) => ({ ...w })) : undefined,
    health: state.health ? JSON.parse(JSON.stringify(state.health)) : undefined,
});

type StateListener = (snapshot: AppStateSnapshot, reason: string) => void;
const listeners = new Set<StateListener>();

export const subscribeToState = (listener: StateListener): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const emitStateSnapshot = (reason: string): AppStateSnapshot => {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
        try {
            listener(snapshot, reason);
        } catch (error) {
            console.error('State listener error:', error);
        }
    }
    return snapshot;
};
