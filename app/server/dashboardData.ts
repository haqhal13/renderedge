/**
 * Dashboard Data Collector
 * Aggregates data from marketTracker and priceStreamLogger for the web dashboard
 */

import marketTracker, { MarketStats } from '../../src/services/marketTracker';
import priceStreamLogger from '../../src/services/priceStreamLogger';
import { ENV } from '../../src/config/env';
import getMyBalance from '../../src/utils/getMyBalance';
import { DashboardUpdate, MarketData, PortfolioSummary, PnLHistoryEntry } from './types';

// Interface for PaperTrader (injected at runtime)
interface PaperTraderInterface {
  getBalance(): number;
  getStartingBalance(): number;
  getPnLHistory(): Array<{
    marketName: string;
    conditionId: string;
    totalPnl: number;
    pnlPercent: number;
    priceUp: number;
    priceDown: number;
    sharesUp: number;
    sharesDown: number;
    timestamp: number;
  }>;
}

export class DashboardDataCollector {
  private paperTrader: PaperTraderInterface | null = null;
  private walletBalance: number | null = null;
  private walletStartingBalance: number | null = null;

  /**
   * Set the paper trader instance (called from main bot)
   */
  setPaperTrader(trader: PaperTraderInterface): void {
    this.paperTrader = trader;
  }

  /**
   * Reset dashboard state (called when bot is reset)
   */
  reset(): void {
    this.walletBalance = null;
    this.walletStartingBalance = null;
    // Note: paperTrader is not reset here - it will be reset separately if needed
  }

  /**
   * Refresh on-chain wallet balance for the main wallet
   * Uses PROXY_WALLET if set, otherwise the first USER_ADDRESSES entry.
   */
  async refreshWalletBalance(): Promise<void> {
    try {
      const primaryAddress =
        (ENV.PROXY_WALLET && ENV.PROXY_WALLET.length > 0)
          ? ENV.PROXY_WALLET
          : (ENV.USER_ADDRESSES && ENV.USER_ADDRESSES.length > 0
              ? ENV.USER_ADDRESSES[0]
              : null);

      if (!primaryAddress) {
        return;
      }

      const balance = await getMyBalance(primaryAddress);

      if (this.walletStartingBalance === null) {
        this.walletStartingBalance = balance;
      }
      this.walletBalance = balance;
    } catch {
      // Swallow errors - dashboard should continue rendering even if RPC fails
    }
  }

  /**
   * Get the current dashboard state as a WebSocket message
   */
  getDashboardUpdate(): DashboardUpdate {
    const now = Date.now();

    // Get all markets from tracker
    const marketsMap = marketTracker.getMarkets();
    const markets = Array.from(marketsMap.values());

    // Get stream info to determine current vs upcoming (supports older loggers without getNextMarkets)
    const anyLogger = priceStreamLogger as unknown as {
      getCurrentMarkets?: () => Map<string, any>;
      getNextMarkets?: () => Map<string, any>;
    };
    const currentMarketsFromStream = anyLogger.getCurrentMarkets
      ? anyLogger.getCurrentMarkets()
      : new Map<string, any>();
    const nextMarketsFromStream = anyLogger.getNextMarkets
      ? anyLogger.getNextMarkets()
      : new Map<string, any>();

    // Build set of next market condition IDs for classification
    const nextConditionIds = new Set<string>();
    const nextAssetIds = new Set<string>();
    for (const info of nextMarketsFromStream.values()) {
      if (info.condition_id) nextConditionIds.add(info.condition_id);
      for (const token of info.tokens || []) {
        if (token.token_id) nextAssetIds.add(token.token_id);
      }
    }

    // Transform and classify markets
    const allMarketData: MarketData[] = markets.map(m => this.transformMarket(m, now));

    // Separate current vs upcoming, filtering out expired/resolved markets
    const currentMarkets: MarketData[] = [];
    const upcomingMarkets: MarketData[] = [];

    for (let i = 0; i < markets.length; i++) {
      const market = markets[i];
      const marketData = allMarketData[i];

      // Skip expired markets entirely - they should not be in currentMarkets or upcomingMarkets
      if (marketData.isExpired) {
        continue;
      }

      // Skip markets with resolved prices (one side = 0 or 1, indicating market settled)
      const priceUp = market.currentPriceUp || 0;
      const priceDown = market.currentPriceDown || 0;
      const isResolved = priceUp >= 0.99 || priceUp <= 0.01 || priceDown >= 0.99 || priceDown <= 0.01;
      if (isResolved && (market.sharesUp > 0 || market.sharesDown > 0)) {
        // Market has resolved - don't include in live dashboard, it will be in pnlHistory
        continue;
      }

      const isUpcoming = this.isMarketUpcoming(market, nextConditionIds, nextAssetIds, now);

      if (isUpcoming) {
        upcomingMarkets.push(marketData);
      } else {
        currentMarkets.push(marketData);
      }
    }

    // Sort current by invested amount (descending)
    currentMarkets.sort((a, b) => (b.investedUp + b.investedDown) - (a.investedUp + a.investedDown));

    // Sort upcoming by end date (soonest first), selecting one per category
    const upcomingByCategory = new Map<string, MarketData>();
    upcomingMarkets.sort((a, b) => (a.endDate || Infinity) - (b.endDate || Infinity));
    for (const m of upcomingMarkets) {
      if (!upcomingByCategory.has(m.category)) {
        upcomingByCategory.set(m.category, m);
      }
    }

    // Calculate portfolio summary
    const portfolio = this.calculatePortfolio(currentMarkets, Array.from(upcomingByCategory.values()));

    // Determine mode
    let mode: 'PAPER' | 'WATCH' | 'TRADING' = 'TRADING';
    if (ENV.PAPER_MODE) mode = 'PAPER';
    else if (ENV.TRACK_ONLY_MODE) mode = 'WATCH';

    // Get PnL history
    const pnlHistory = this.getPnLHistory();

    return {
      type: 'dashboard_update',
      timestamp: now,
      data: {
        mode,
        currentMarkets: currentMarkets.slice(0, 4),
        upcomingMarkets: Array.from(upcomingByCategory.values()).slice(0, 4),
        portfolio,
        pnlHistory,
      },
    };
  }

  /**
   * Get PnL history from paper trader
   */
  private getPnLHistory(): PnLHistoryEntry[] {
    if (!this.paperTrader) return [];

    try {
      const history = this.paperTrader.getPnLHistory();
      return history.map(entry => ({
        ...entry,
        outcome: entry.priceUp > entry.priceDown ? 'UP' :
                 entry.priceDown > entry.priceUp ? 'DOWN' : 'UNKNOWN'
      }));
    } catch (e) {
      return [];
    }
  }

  /**
   * Transform a MarketStats to MarketData for the frontend
   */
  private transformMarket(market: MarketStats, now: number): MarketData {
    const totalInvested = market.investedUp + market.investedDown;
    const totalCostBasis = market.totalCostUp + market.totalCostDown;

    // Calculate current values
    let currentValueUp = 0;
    let currentValueDown = 0;
    let pnlUp = 0;
    let pnlDown = 0;

    if (market.currentPriceUp && market.currentPriceUp > 0 && market.sharesUp > 0) {
      currentValueUp = market.sharesUp * market.currentPriceUp;
      pnlUp = currentValueUp - market.totalCostUp;
    }

    if (market.currentPriceDown && market.currentPriceDown > 0 && market.sharesDown > 0) {
      currentValueDown = market.sharesDown * market.currentPriceDown;
      pnlDown = currentValueDown - market.totalCostDown;
    }

    const totalPnL = pnlUp + pnlDown;
    const totalPnLPercent = totalCostBasis > 0 ? (totalPnL / totalCostBasis) * 100 : 0;
    const pnlUpPercent = market.totalCostUp > 0 ? (pnlUp / market.totalCostUp) * 100 : 0;
    const pnlDownPercent = market.totalCostDown > 0 ? (pnlDown / market.totalCostDown) * 100 : 0;

    // Calculate distribution
    const upPercent = totalInvested > 0 ? (market.investedUp / totalInvested) * 100 : 50;
    const downPercent = totalInvested > 0 ? (market.investedDown / totalInvested) * 100 : 50;

    // Calculate time remaining
    let timeRemaining = '';
    let isExpired = false;
    if (market.endDate) {
      const timeLeftMs = market.endDate - now;
      if (timeLeftMs > 0) {
        const mins = Math.floor(timeLeftMs / 60000);
        const secs = Math.floor((timeLeftMs % 60000) / 1000);
        timeRemaining = `${mins}m ${secs}s`;
      } else {
        timeRemaining = 'Expired';
        isExpired = true;
      }
    }

    // Determine category
    let category = 'Unknown';
    if (market.marketKey.includes('BTC') && market.marketKey.includes('-15')) {
      category = 'BTC-15m';
    } else if (market.marketKey.includes('ETH') && market.marketKey.includes('-15')) {
      category = 'ETH-15m';
    } else if (market.marketKey.includes('BTC') && market.marketKey.includes('-1h')) {
      category = 'BTC-1h';
    } else if (market.marketKey.includes('ETH') && market.marketKey.includes('-1h')) {
      category = 'ETH-1h';
    }

    return {
      marketKey: market.marketKey,
      marketName: market.marketName,
      category,
      endDate: market.endDate || null,
      timeRemaining,
      isExpired,
      priceUp: market.currentPriceUp || null,
      priceDown: market.currentPriceDown || null,
      sharesUp: market.sharesUp,
      sharesDown: market.sharesDown,
      investedUp: market.investedUp,
      investedDown: market.investedDown,
      totalCostUp: market.totalCostUp,
      totalCostDown: market.totalCostDown,
      currentValueUp,
      currentValueDown,
      pnlUp,
      pnlDown,
      pnlUpPercent,
      pnlDownPercent,
      totalPnL,
      totalPnLPercent,
      tradesUp: market.tradesUp,
      tradesDown: market.tradesDown,
      upPercent,
      downPercent,
    };
  }

  /**
   * Check if a market is upcoming (vs current)
   */
  private isMarketUpcoming(
    market: MarketStats,
    nextConditionIds: Set<string>,
    nextAssetIds: Set<string>,
    now: number
  ): boolean {
    // Match by condition ID
    if (market.conditionId && nextConditionIds.has(market.conditionId)) {
      return true;
    }

    // Match by asset ID
    if (market.assetUp && nextAssetIds.has(market.assetUp)) {
      return true;
    }
    if (market.assetDown && nextAssetIds.has(market.assetDown)) {
      return true;
    }

    // Fallback: use time-based logic
    if (market.endDate) {
      const timeLeft = market.endDate - now;
      const is15Min = market.marketKey.includes('-15');
      const is1Hour = market.marketKey.includes('-1h');

      // If time remaining is more than window duration, it's upcoming
      if (is15Min && timeLeft > 15 * 60 * 1000) return true;
      if (is1Hour && timeLeft > 60 * 60 * 1000) return true;
    }

    return false;
  }

  /**
   * Calculate portfolio summary from all markets
   */
  private calculatePortfolio(currentMarkets: MarketData[], upcomingMarkets: MarketData[]): PortfolioSummary {
    const allMarkets = [...currentMarkets, ...upcomingMarkets];

    let totalInvested = 0;
    let totalCostBasis = 0;
    let totalValue = 0;
    let totalPnL = 0;
    let totalTrades = 0;

    let invested15m = 0;
    let value15m = 0;
    let pnl15m = 0;
    let costBasis15m = 0;
    let trades15m = 0;

    let invested1h = 0;
    let value1h = 0;
    let pnl1h = 0;
    let costBasis1h = 0;
    let trades1h = 0;

    for (const m of allMarkets) {
      const invested = m.investedUp + m.investedDown;
      const costBasis = m.totalCostUp + m.totalCostDown;
      const value = m.currentValueUp + m.currentValueDown;
      const trades = m.tradesUp + m.tradesDown;

      totalInvested += invested;
      totalCostBasis += costBasis;
      totalValue += value;
      totalPnL += m.totalPnL;
      totalTrades += trades;

      if (m.category.includes('15m')) {
        invested15m += invested;
        costBasis15m += costBasis;
        value15m += value;
        pnl15m += m.totalPnL;
        trades15m += trades;
      } else if (m.category.includes('1h')) {
        invested1h += invested;
        costBasis1h += costBasis;
        value1h += value;
        pnl1h += m.totalPnL;
        trades1h += trades;
      }
    }

    const totalPnLPercent = totalCostBasis > 0 ? (totalPnL / totalCostBasis) * 100 : 0;
    const pnl15mPercent = costBasis15m > 0 ? (pnl15m / costBasis15m) * 100 : 0;
    const pnl1hPercent = costBasis1h > 0 ? (pnl1h / costBasis1h) * 100 : 0;

    // Balance:
    // - PAPER mode: use paper trader synthetic balance
    // - WATCH/TRADING: use real on-chain wallet balance if available
    let balance: number;
    let startingBalance: number;

    if (ENV.PAPER_MODE && this.paperTrader) {
      balance = this.paperTrader.getBalance();
      startingBalance = this.paperTrader.getStartingBalance();
    } else {
      balance = this.walletBalance ?? 0;
      startingBalance = this.walletStartingBalance ?? balance;
    }

    return {
      totalInvested,
      totalCostBasis,
      totalValue,
      totalPnL,
      totalPnLPercent,
      invested15m,
      value15m,
      pnl15m,
      pnl15mPercent,
      trades15m,
      invested1h,
      value1h,
      pnl1h,
      pnl1hPercent,
      trades1h,
      balance,
      startingBalance,
      totalTrades,
    };
  }
}

// Singleton instance
export const dashboardDataCollector = new DashboardDataCollector();
export default dashboardDataCollector;
