/**
 * Dual-Side Accumulation Strategy Configuration
 *
 * Configuration for the probability-weighted dual-side accumulation strategy.
 * This strategy:
 * - Buys both sides of binary markets at all times
 * - Tilts allocation toward the dominant (higher probability) side
 * - Maintains minimum exposure to the minority side even at extreme skews
 * - Holds all positions until market resolution
 */

import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Skew zones define how the bot interprets market probability
 */
export interface SkewZoneConfig {
    // Neutral zone: prices close to 50/50
    neutralThreshold: number;       // Max deviation from 50% to be considered neutral (e.g., 0.05 = 45-55%)

    // Moderate zone: meaningful skew but not extreme
    moderateThreshold: number;      // Deviation threshold for moderate (e.g., 0.20 = 30-70%)

    // Everything beyond moderate is considered extreme
}

/**
 * Sizing curve configuration
 * Controls how allocation shifts based on skew
 */
export interface SizingCurveConfig {
    // At neutral (50/50), what's the allocation split?
    neutralAllocation: number;      // Should be 0.5 (50/50)

    // At extreme skew, what's the maximum dominant-side allocation?
    maxDominantAllocation: number;  // E.g., 0.90 = 90% dominant, 10% minority

    // Minimum minority allocation (never goes below this)
    minMinorityAllocation: number;  // E.g., 0.05 = always at least 5% minority

    // Curve shape: how quickly allocation tilts
    // Higher = faster tilt, lower = more gradual
    curveExponent: number;          // 1.0 = linear, 2.0 = quadratic, etc.
}

/**
 * Time-based behavior configuration
 */
export interface TimeConfig {
    // Phase definitions (percentage of time remaining)
    earlyPhaseThreshold: number;    // Above this = early (e.g., 0.75 = first 25% of time)
    midPhaseThreshold: number;      // Above this = mid (e.g., 0.25 = middle 50%)
    latePhaseThreshold: number;     // Above this = late (e.g., 0.05 = next 20%)
    // Below latePhaseThreshold = final phase (last 5%)

    // Buy intensity multipliers by phase
    earlyIntensity: number;         // E.g., 0.5 = half intensity early
    midIntensity: number;           // E.g., 1.0 = full intensity mid
    lateIntensity: number;          // E.g., 1.5 = increased intensity late
    finalIntensity: number;         // E.g., 0.0 = no new trades in final phase

    // Minimum time before resolution to stop trading (ms)
    minTimeBeforeResolution: number; // E.g., 60000 = stop 1 minute before

    // Minimum market duration to trade (ms) - skip very short markets
    minMarketDuration: number;       // E.g., 300000 = 5 minutes minimum
}

/**
 * Safety and discipline configuration
 */
export interface SafetyConfig {
    // Capital limits
    maxCapitalPerMarket: number;    // Maximum USD to deploy in a single market
    minTradeSize: number;           // Minimum trade size in USD
    maxTradeSize: number;           // Maximum single trade size

    // Position limits
    maxActiveMarkets: number;       // Maximum concurrent market positions
    maxCapitalDeployedPercent: number; // Max % of total capital in markets

    // Trading pace
    minSecondsBetweenTrades: number; // Throttle: minimum gap between trades
    minSecondsBetweenSameMarket: number; // Gap between trades in same market

    // Skew stability
    skewStabilityWindow: number;    // Seconds to wait for skew stability
    skewVolatilityThreshold: number; // Max skew change to consider "stable"

    // Gap thresholds
    allocationGapThreshold: number; // Min gap between current/target to trade
    rebalanceThreshold: number;     // Min gap to trigger rebalancing
}

/**
 * Market filtering configuration
 */
export interface MarketFilterConfig {
    // Market types to include
    includePatterns: string[];      // Regex patterns for market slugs/titles

    // Market types to exclude
    excludePatterns: string[];      // Regex patterns to exclude

    // Minimum liquidity
    minLiquidity: number;           // Minimum liquidity in USD

    // Minimum volume
    minVolume24h: number;           // Minimum 24h volume

    // Time constraints
    minTimeToResolution: number;    // Minimum ms until resolution
    maxTimeToResolution: number;    // Maximum ms until resolution
}

/**
 * Complete dual-side accumulation strategy configuration
 */
export interface DualSideStrategyConfig {
    // Core settings
    startingCapital: number;        // Initial paper trading capital

    // Strategy components
    skewZones: SkewZoneConfig;
    sizingCurve: SizingCurveConfig;
    time: TimeConfig;
    safety: SafetyConfig;
    marketFilter: MarketFilterConfig;

    // Operational settings
    priceUpdateInterval: number;    // How often to fetch prices (ms)
    decisionInterval: number;       // How often to make trade decisions (ms)
    displayInterval: number;        // How often to update display (ms)

    // Logging
    logTrades: boolean;             // Log each trade
    logDecisions: boolean;          // Log trade decisions (including skips)
    csvLogging: boolean;            // Write to CSV files
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: DualSideStrategyConfig = {
    startingCapital: 5000,          // $5000 paper trading capital

    skewZones: {
        neutralThreshold: 0.03,     // 47-53% is neutral (more sensitive to skew)
        moderateThreshold: 0.25,    // 25-75% is moderate
    },

    sizingCurve: {
        neutralAllocation: 0.50,    // 50/50 at neutral
        maxDominantAllocation: 0.95, // Max 95% dominant
        minMinorityAllocation: 0.05, // Always at least 5% minority
        curveExponent: 1.2,         // More aggressive tilt in mid-range
    },

    time: {
        earlyPhaseThreshold: 0.75,  // First 25% = early
        midPhaseThreshold: 0.25,    // Middle 50% = mid
        latePhaseThreshold: 0.05,   // Next 20% = late
        // Last 5% = final

        earlyIntensity: 0.6,        // 60% intensity early
        midIntensity: 1.0,          // Full intensity mid
        lateIntensity: 1.3,         // 130% intensity late
        finalIntensity: 1.0,        // Allow trades in final phase

        minTimeBeforeResolution: 30 * 1000,     // Stop 30 seconds before
        minMarketDuration: 5 * 60 * 1000,       // 5 minute minimum duration
    },

    safety: {
        maxCapitalPerMarket: 300,   // Max $300 per market (scale toward watched trader)
        minTradeSize: 0.50,         // Minimum $0.50 per trade
        maxTradeSize: 25,           // Max $25 per trade

        maxActiveMarkets: 4,        // Focus on up to 4 markets like watcher dashboard
        maxCapitalDeployedPercent: 0.80, // Max 80% of capital deployed

        minSecondsBetweenTrades: 3,     // 3 seconds between any trades (more frequent like target trader)
        minSecondsBetweenSameMarket: 10, // 10 seconds between same-market trades

        skewStabilityWindow: 10,        // 10 seconds for stability check (more reactive to skew)
        skewVolatilityThreshold: 0.15,  // 15% change = volatile (allow more movement before blocking)

        allocationGapThreshold: 0.03,   // 3% gap minimum to trade (tighter, more trades)
        rebalanceThreshold: 0.07,       // 7% gap to trigger rebalance
    },

    marketFilter: {
        includePatterns: [
            'btc.*up.*down',
            'eth.*up.*down',
            'bitcoin.*up.*down',
            'ethereum.*up.*down',
            'sol.*up.*down',
            'solana.*up.*down',
        ],
        excludePatterns: [],

        minLiquidity: 100,          // $100 minimum liquidity
        minVolume24h: 50,           // $50 minimum 24h volume

        minTimeToResolution: 2 * 60 * 1000,     // At least 2 minutes left
        maxTimeToResolution: 24 * 60 * 60 * 1000, // Max 24 hours out
    },

    priceUpdateInterval: 5 * 1000,   // Update prices every 5 seconds
    decisionInterval: 1 * 1000,      // Make decisions every 1 second (match watcher cadence)
    displayInterval: 2 * 1000,       // Update display every 2 seconds

    logTrades: true,
    logDecisions: false,            // Don't log every decision (noisy)
    csvLogging: true,
};

/**
 * Parse configuration from environment variables
 */
export function parseConfig(): DualSideStrategyConfig {
    const config = { ...DEFAULT_CONFIG };

    // Override from environment if set
    if (process.env.PAPER_STARTING_CAPITAL) {
        config.startingCapital = parseFloat(process.env.PAPER_STARTING_CAPITAL);
    }

    if (process.env.PAPER_MAX_PER_MARKET) {
        config.safety.maxCapitalPerMarket = parseFloat(process.env.PAPER_MAX_PER_MARKET);
    }

    if (process.env.PAPER_MIN_TRADE) {
        config.safety.minTradeSize = parseFloat(process.env.PAPER_MIN_TRADE);
    }

    if (process.env.PAPER_MAX_TRADE) {
        config.safety.maxTradeSize = parseFloat(process.env.PAPER_MAX_TRADE);
    }

    if (process.env.PAPER_MAX_MARKETS) {
        config.safety.maxActiveMarkets = parseInt(process.env.PAPER_MAX_MARKETS, 10);
    }

    if (process.env.PAPER_PRICE_INTERVAL) {
        config.priceUpdateInterval = parseInt(process.env.PAPER_PRICE_INTERVAL, 10) * 1000;
    }

    if (process.env.PAPER_DECISION_INTERVAL) {
        config.decisionInterval = parseInt(process.env.PAPER_DECISION_INTERVAL, 10) * 1000;
    }

    // Sizing curve overrides
    if (process.env.PAPER_MAX_DOMINANT_ALLOC) {
        config.sizingCurve.maxDominantAllocation = parseFloat(process.env.PAPER_MAX_DOMINANT_ALLOC);
    }

    if (process.env.PAPER_MIN_MINORITY_ALLOC) {
        config.sizingCurve.minMinorityAllocation = parseFloat(process.env.PAPER_MIN_MINORITY_ALLOC);
    }

    if (process.env.PAPER_CURVE_EXPONENT) {
        config.sizingCurve.curveExponent = parseFloat(process.env.PAPER_CURVE_EXPONENT);
    }

    // Market filter patterns
    if (process.env.PAPER_INCLUDE_PATTERNS) {
        config.marketFilter.includePatterns = process.env.PAPER_INCLUDE_PATTERNS.split(',').map(p => p.trim());
    }

    if (process.env.PAPER_EXCLUDE_PATTERNS) {
        config.marketFilter.excludePatterns = process.env.PAPER_EXCLUDE_PATTERNS.split(',').map(p => p.trim());
    }

    // Logging
    if (process.env.PAPER_LOG_TRADES) {
        config.logTrades = process.env.PAPER_LOG_TRADES === 'true';
    }

    if (process.env.PAPER_LOG_DECISIONS) {
        config.logDecisions = process.env.PAPER_LOG_DECISIONS === 'true';
    }

    if (process.env.PAPER_CSV_LOGGING) {
        config.csvLogging = process.env.PAPER_CSV_LOGGING === 'true';
    }

    return config;
}

/**
 * Validate configuration
 */
export function validateConfig(config: DualSideStrategyConfig): string[] {
    const errors: string[] = [];

    // Capital validation
    if (config.startingCapital <= 0) {
        errors.push('startingCapital must be positive');
    }

    // Sizing curve validation
    if (config.sizingCurve.neutralAllocation !== 0.5) {
        errors.push('neutralAllocation should be 0.5 (50/50)');
    }

    if (config.sizingCurve.maxDominantAllocation <= 0.5 || config.sizingCurve.maxDominantAllocation > 0.99) {
        errors.push('maxDominantAllocation must be between 0.5 and 0.99');
    }

    if (config.sizingCurve.minMinorityAllocation <= 0 || config.sizingCurve.minMinorityAllocation >= 0.5) {
        errors.push('minMinorityAllocation must be between 0 and 0.5');
    }

    if (config.sizingCurve.maxDominantAllocation + config.sizingCurve.minMinorityAllocation > 1) {
        errors.push('maxDominantAllocation + minMinorityAllocation cannot exceed 1.0');
    }

    // Safety validation
    if (config.safety.minTradeSize >= config.safety.maxTradeSize) {
        errors.push('minTradeSize must be less than maxTradeSize');
    }

    if (config.safety.maxCapitalPerMarket > config.startingCapital) {
        errors.push('maxCapitalPerMarket cannot exceed startingCapital');
    }

    // Time validation
    if (config.time.earlyPhaseThreshold <= config.time.midPhaseThreshold) {
        errors.push('earlyPhaseThreshold must be greater than midPhaseThreshold');
    }

    if (config.time.midPhaseThreshold <= config.time.latePhaseThreshold) {
        errors.push('midPhaseThreshold must be greater than latePhaseThreshold');
    }

    return errors;
}

// Export parsed configuration
export const PAPER_CONFIG = parseConfig();

// Validate on load
const configErrors = validateConfig(PAPER_CONFIG);
if (configErrors.length > 0) {
    console.error('Paper trading configuration errors:');
    configErrors.forEach(err => console.error(`  - ${err}`));
}
