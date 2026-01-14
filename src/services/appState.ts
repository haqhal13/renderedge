import { HealthCheckResult } from '../utils/healthCheck';

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
    updatedAt: number;
}

export interface AppStateSnapshot {
    mode: 'TRACK_ONLY' | 'TRADING';
    running: boolean;
    status: string;
    traders: PositionSnapshot[];
    trades: TradeEventPayload[];
    executions: ExecutionEventPayload[];
    myPortfolio?: PortfolioSnapshot;
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

export const getSnapshot = (): AppStateSnapshot => ({
    ...state,
    traders: state.traders.map((s) => ({ ...s, topPositions: s.topPositions?.map((p) => ({ ...p })) })),
    trades: state.trades.map((trade) => ({ ...trade })),
    executions: state.executions.map((exec) => ({ ...exec })),
    myPortfolio: state.myPortfolio ? { ...state.myPortfolio } : undefined,
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
