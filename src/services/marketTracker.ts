import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import priceStreamLogger from './priceStreamLogger';
import { getRunId } from '../utils/runId';

/**
 * Helper function to break down timestamp into detailed components
 */
function getTimestampBreakdown(timestamp: number): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
} {
    const date = new Date(timestamp);
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1, // 1-12
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
        millisecond: date.getUTCMilliseconds(),
    };
}

export interface MarketStats {
    marketKey: string; // e.g., "BTC-15min"
    marketName: string; // Full market name
    sharesUp: number;
    sharesDown: number;
    investedUp: number;
    investedDown: number;
    totalCostUp: number; // Total cost for UP shares (for average calculation)
    totalCostDown: number; // Total cost for DOWN shares (for average calculation)
    tradesUp: number;
    tradesDown: number;
    lastUpdate: number;
    endDate?: number; // Market end date timestamp (if available)
    conditionId?: string; // Condition ID for market lookup
    assetUp?: string; // Asset ID for UP outcome
    assetDown?: string; // Asset ID for DOWN outcome
    currentPriceUp?: number; // Current market price for UP
    currentPriceDown?: number; // Current market price for DOWN
    lastPriceUpdate?: number; // Timestamp of last price update
    marketOpenTime?: number; // Timestamp when this market was first opened
    category?: string; // Market category (e.g., "BTC-UpDown-15", "ETH-UpDown-15")
}

class MarketTracker {
    private markets: Map<string, MarketStats> = new Map();
    private lastDisplayTime = 0;
    // Stable dashboard: update every 1s unless new market forces immediate refresh
    private displayInterval = 1000;
    private lastMarketCount = 0;
    private loggedMarkets: Set<string> = new Set(); // Track markets already logged to CSV
    private csvFilePath: string;
    private maxMarkets = 4; // Maximum number of markets to track at once
    private marketsToClose: MarketStats[] = []; // Markets that need to be closed
    private onMarketCloseCallback?: (market: MarketStats) => Promise<void>; // Callback for closing positions
    private processedTrades: Set<string> = new Set(); // Track processed trades to prevent double-counting
    private displayMode: 'WATCH' | 'TRADING' | 'PAPER' = 'TRADING'; // Display mode for header
    private isDisplaying = false; // Lock to prevent concurrent display updates

    constructor() {
        // Initialize CSV file path in watcher folder with run ID
        const logsDir = path.join(process.cwd(), 'logs');
        const watcherDir = path.join(logsDir, 'watcher');
        
        // Create directories
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        if (!fs.existsSync(watcherDir)) {
            fs.mkdirSync(watcherDir, { recursive: true });
        }
        
        const runId = getRunId();
        this.csvFilePath = path.join(watcherDir, `Watcher Market PNL_${runId}.csv`);
        this.initializeCsvFile();
    }

    /**
     * Initialize CSV file with headers (always create new file for each run)
     */
    private initializeCsvFile(): void {
        try {
            const headers = [
                'Timestamp',
                'Date',
                'Year',
                'Month',
                'Day',
                'Hour',
                'Minute',
                'Second',
                'Millisecond',
                'Market Key',
                'Market Name',
                'Condition ID',
                'Invested Up ($)',
                'Invested Down ($)',
                'Total Invested ($)',
                'Shares Up',
                'Shares Down',
                'Final Price Up ($)',
                'Final Price Down ($)',
                'Final Value Up ($)',
                'Final Value Down ($)',
                'Total Final Value ($)',
                'PnL Up ($)',
                'PnL Down ($)',
                'Total PnL ($)',
                'PnL Percent (%)',
                'Trades Up',
                'Trades Down',
                'Outcome',
                'Market Switch Reason'
            ].join(',');
            fs.writeFileSync(this.csvFilePath, headers + '\n', 'utf8');
            console.log(`✓ Created CSV file: ${this.csvFilePath}`);
        } catch (error) {
            console.error(`✗ Failed to create CSV file ${this.csvFilePath}:`, error);
        }
    }

    /**
     * Fetch final prices for a closed market
     */
    private async fetchFinalPrices(market: MarketStats): Promise<{ priceUp?: number; priceDown?: number }> {
        const prices: { priceUp?: number; priceDown?: number } = {};

        try {
            // Try to get final prices from positions of tracked traders
            for (const traderAddress of ENV.USER_ADDRESSES) {
                try {
                    const positions = await fetchData(
                        `https://data-api.polymarket.com/positions?user=${traderAddress}`
                    ).catch(() => null);

                    if (Array.isArray(positions)) {
                        for (const pos of positions) {
                            if (market.assetUp && pos.asset === market.assetUp && pos.curPrice !== undefined) {
                                prices.priceUp = parseFloat(pos.curPrice);
                            }
                            if (market.assetDown && pos.asset === market.assetDown && pos.curPrice !== undefined) {
                                prices.priceDown = parseFloat(pos.curPrice);
                            }
                        }
                    }
                } catch (e) {
                    // Continue to next trader
                }
            }

            // If we have current prices from the market, use those as fallback
            if (prices.priceUp === undefined && market.currentPriceUp !== undefined) {
                prices.priceUp = market.currentPriceUp;
            }
            if (prices.priceDown === undefined && market.currentPriceDown !== undefined) {
                prices.priceDown = market.currentPriceDown;
            }
        } catch (e) {
            // Silently fail - will use current prices if available
        }

        return prices;
    }

    /**
     * Log closed market PnL to CSV file
     */
    private async logClosedMarketPnL(market: MarketStats): Promise<void> {
        // Skip if already logged
        if (this.loggedMarkets.has(market.marketKey)) {
            return;
        }

        // Fetch final prices
        const finalPrices = await this.fetchFinalPrices(market);

        // Calculate final values and PnL
        const totalInvested = market.investedUp + market.investedDown;
        
        let finalValueUp = 0;
        let finalValueDown = 0;
        let pnlUp = 0;
        let pnlDown = 0;

        const finalPriceUp = finalPrices.priceUp ?? market.currentPriceUp ?? 0;
        const finalPriceDown = finalPrices.priceDown ?? market.currentPriceDown ?? 0;

        if (market.sharesUp > 0 && finalPriceUp > 0) {
            finalValueUp = market.sharesUp * finalPriceUp;
            pnlUp = finalValueUp - market.investedUp;
        }

        if (market.sharesDown > 0 && finalPriceDown > 0) {
            finalValueDown = market.sharesDown * finalPriceDown;
            pnlDown = finalValueDown - market.investedDown;
        }

        const totalFinalValue = finalValueUp + finalValueDown;
        const totalPnl = pnlUp + pnlDown;
        const pnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

        // Determine outcome
        let outcome = 'Unknown';
        if (finalPriceUp >= 0.99) {
            outcome = 'UP Won';
        } else if (finalPriceUp <= 0.01) {
            outcome = 'UP Lost';
        } else if (finalPriceDown >= 0.99) {
            outcome = 'DOWN Won';
        } else if (finalPriceDown <= 0.01) {
            outcome = 'DOWN Lost';
        } else if (totalPnl > 0) {
            outcome = 'Profit';
        } else if (totalPnl < 0) {
            outcome = 'Loss';
        }

        // Create CSV row with full timestamp breakdown
        const timestamp = Date.now();
        const date = new Date().toISOString();
        const timeBreakdown = getTimestampBreakdown(timestamp);
        const row = [
            timestamp,
            date,
            timeBreakdown.year,
            timeBreakdown.month,
            timeBreakdown.day,
            timeBreakdown.hour,
            timeBreakdown.minute,
            timeBreakdown.second,
            timeBreakdown.millisecond,
            market.marketKey,
            `"${market.marketName.replace(/"/g, '""')}"`, // Escape quotes in market name
            market.conditionId || '',
            market.investedUp.toFixed(2),
            market.investedDown.toFixed(2),
            totalInvested.toFixed(2),
            market.sharesUp.toFixed(4),
            market.sharesDown.toFixed(4),
            finalPriceUp.toFixed(4),
            finalPriceDown.toFixed(4),
            finalValueUp.toFixed(2),
            finalValueDown.toFixed(2),
            totalFinalValue.toFixed(2),
            pnlUp.toFixed(2),
            pnlDown.toFixed(2),
            totalPnl.toFixed(2),
            pnlPercent.toFixed(2),
            market.tradesUp,
            market.tradesDown,
            outcome,
            'Market Closed' // Market Switch Reason
        ].join(',');

        // Append to CSV file
        try {
            fs.appendFileSync(this.csvFilePath, row + '\n', 'utf8');
            this.loggedMarkets.add(market.marketKey);
        } catch (error) {
            console.error(`Failed to write PnL to CSV: ${error}`);
        }
    }

    /**
     * Check if market is 15min or hourly (1h) market
     * Returns true if market matches 15min or hourly pattern
     */
    private is15MinOrHourlyMarket(activity: any): boolean {
        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            '';
        
        if (!rawTitle) return false;
        
        const titleLower = rawTitle.toLowerCase();
        
        // Check for 15-minute timeframe
        const has15Min = /\b15\s*min|\b15min|updown.*?15|15.*?updown/i.test(rawTitle);
        
        // Check for hourly timeframe (1h, 1 hour, hourly)
        const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(rawTitle);
        
        // Check for hourly markets by pattern: "Up or Down" with single time (e.g., "6AM ET") but NO time range
        // Hourly markets: "Bitcoin Up or Down - December 24, 6AM ET" (single time, no range)
        // 15min markets: "Bitcoin Up or Down - December 24, 6:00AM-6:15AM ET" (has time range with colon)
        // Also handle slug format: "bitcoin-up-or-down-december-24-9am-et" (with hyphens)
        const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(titleLower);
        const hasCrypto = /(?:bitcoin|ethereum|btc|eth)/i.test(rawTitle);
        // Pattern like "6AM ET" or "7PM ET" (with spaces) OR "9am-et" (with hyphens in slug)
        const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(rawTitle) || /\d{1,2}(?:am|pm)-et/i.test(rawTitle);
        const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(rawTitle); // Pattern like "6:00AM-6:15AM"
        
        // If it's an Up/Down crypto market with single time but NO time range, it's hourly
        const isHourlyPattern = hasUpDown && hasCrypto && hasSingleTime && !hasTimeRange;
        
        return has15Min || hasHourly || isHourlyPattern;
    }

    /**
     * Check if market is ETH-UpDown-15 or BTC-UpDown-15 type
     * Returns normalized key like "ETH-UpDown-15" or "BTC-UpDown-15" if it matches, null otherwise
     */
    private getUpDown15MarketType(activity: any): string | null {
        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            '';
        
        if (!rawTitle) return null;
        
        const titleLower = rawTitle.toLowerCase();
        
        // Check for 15-minute timeframe first
        const has15Min = /\b15\s*min|\b15min|updown.*?15|15.*?updown/i.test(rawTitle);
        
        // Check for hourly timeframe (explicit)
        const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(rawTitle);
        
        // Check for hourly markets by pattern: "Up or Down" with single time (e.g., "6AM ET") but NO time range
        // Also handle slug format: "bitcoin-up-or-down-december-24-9am-et" (with hyphens)
        const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(titleLower);
        const hasCrypto = /(?:bitcoin|ethereum|btc|eth)/i.test(rawTitle);
        // Pattern like "6AM ET" or "7PM ET" (with spaces) OR "9am-et" (with hyphens in slug)
        const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(rawTitle) || /\d{1,2}(?:am|pm)-et/i.test(rawTitle);
        const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(rawTitle); // Pattern like "6:00AM-6:15AM"
        const isHourlyPattern = hasUpDown && hasCrypto && hasSingleTime && !hasTimeRange;
        
        // If it's not 15min, not explicitly hourly, and not hourly by pattern, skip
        if (!has15Min && !hasHourly && !isHourlyPattern) {
            return null;
        }
        
        // Check for UpDown pattern (up/down/updown) - required for categorization
        if (hasUpDown || has15Min || hasHourly || isHourlyPattern) {
            // Check for Bitcoin
            if (titleLower.includes('bitcoin') || titleLower.includes('btc') || /^btc/i.test(rawTitle)) {
                return has15Min ? 'BTC-UpDown-15' : 'BTC-UpDown-1h';
            }
            // Check for Ethereum
            if (titleLower.includes('ethereum') || titleLower.includes('eth') || /^eth/i.test(rawTitle)) {
                return has15Min ? 'ETH-UpDown-15' : 'ETH-UpDown-1h';
            }
        }
        
        return null;
    }

    /**
     * Extract market category for grouping similar markets
     * Returns category string like "BTC-UpDown-15" or "ETH-UpDown-1h"
     */
    private extractMarketCategory(activity: any): string | null {
        const upDownType = this.getUpDown15MarketType(activity);
        if (upDownType) {
            return upDownType;
        }
        
        // Try to extract category from market name
        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            '';
        
        if (!rawTitle) return null;
        
        const titleLower = rawTitle.toLowerCase();
        
        // Check for Bitcoin
        if (titleLower.includes('bitcoin') || titleLower.includes('btc') || /^btc/i.test(rawTitle)) {
            const has15Min = /\b15\s*min|\b15min/i.test(rawTitle);
            const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(rawTitle);
            // Also check for hourly pattern: single time without range
            // Handle both title format (with spaces) and slug format (with hyphens)
            const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(titleLower);
            const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(rawTitle) || /\d{1,2}(?:am|pm)-et/i.test(rawTitle);
            const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(rawTitle);
            const isHourlyPattern = hasUpDown && hasSingleTime && !hasTimeRange;
            
            if (has15Min) return 'BTC-UpDown-15';
            if (hasHourly || isHourlyPattern) return 'BTC-UpDown-1h';
            return 'BTC';
        }
        
        // Check for Ethereum
        if (titleLower.includes('ethereum') || titleLower.includes('eth') || /^eth/i.test(rawTitle)) {
            const has15Min = /\b15\s*min|\b15min/i.test(rawTitle);
            const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(rawTitle);
            // Also check for hourly pattern: single time without range
            // Handle both title format (with spaces) and slug format (with hyphens)
            const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(titleLower);
            const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(rawTitle) || /\d{1,2}(?:am|pm)-et/i.test(rawTitle);
            const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(rawTitle);
            const isHourlyPattern = hasUpDown && hasSingleTime && !hasTimeRange;
            
            if (has15Min) return 'ETH-UpDown-15';
            if (hasHourly || isHourlyPattern) return 'ETH-UpDown-1h';
            return 'ETH';
        }
        
        return null;
    }

    /**
     * Set callback for closing positions when markets are switched
     */
    setMarketCloseCallback(callback: (market: MarketStats) => Promise<void>): void {
        this.onMarketCloseCallback = callback;
    }

    /**
     * Extract market key from activity
     * Priority:
     * 1) Normalized UpDown-15 or UpDown-1h key (for BTC/ETH markets)
     * 2) conditionId (most stable per market)
     * 3) slug / eventSlug
     * 4) title / asset fallback
     */
    private extractMarketKey(activity: any): string {
        // Get raw title once for reuse
        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            '';

        // Check for ETH-UpDown-15, ETH-UpDown-1h, BTC-UpDown-15, or BTC-UpDown-1h markets
        const upDownType = this.getUpDown15MarketType(activity);
        if (upDownType) {
            // For 15min markets, use the category directly as key
            if (upDownType === 'BTC-UpDown-15' || upDownType === 'ETH-UpDown-15') {
                return upDownType;
            }
            
            // For hourly markets, we need to add the hour to make unique keys
            // Extract the hour from the time (e.g., "9AM ET" -> "9" or "9am-et" -> "9")
            if (rawTitle) {
                // Try pattern with spaces first (title format), then with hyphens (slug format)
                let timeMatch = rawTitle.match(/(\d{1,2})\s*(?:am|pm)\s*et/i);
                if (!timeMatch) {
                    timeMatch = rawTitle.match(/(\d{1,2})(?:am|pm)-et/i);
                }
                if (timeMatch) {
                    const hour = timeMatch[1];
                    // Return unique key with hour: BTC-UpDown-1h-9, ETH-UpDown-1h-9, etc.
                    return `${upDownType}-${hour}`;
                }
            }
            // Fallback: use category without hour (shouldn't happen, but safe fallback)
            return upDownType;
        }

        // For hourly markets detected by pattern but not categorized above, try to create a key
        if (rawTitle) {
            const titleLower = rawTitle.toLowerCase();
            const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(titleLower);
            // Handle both title format (with spaces) and slug format (with hyphens)
            const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(rawTitle) || /\d{1,2}(?:am|pm)-et/i.test(rawTitle);
            const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(rawTitle);
            const isHourlyPattern = hasUpDown && hasSingleTime && !hasTimeRange;
            
            if (isHourlyPattern) {
                // Extract the hour from the time (e.g., "6AM ET" -> "6" or "9am-et" -> "9")
                // Try pattern with spaces first (title format), then with hyphens (slug format)
                let timeMatch = rawTitle.match(/(\d{1,2})\s*(?:am|pm)\s*et/i);
                if (!timeMatch) {
                    timeMatch = rawTitle.match(/(\d{1,2})(?:am|pm)-et/i);
                }
                if (timeMatch) {
                    const hour = timeMatch[1];
                    // Check for crypto
                    if (titleLower.includes('bitcoin') || titleLower.includes('btc')) {
                        return `BTC-UpDown-1h-${hour}`;
                    }
                    if (titleLower.includes('ethereum') || titleLower.includes('eth')) {
                        return `ETH-UpDown-1h-${hour}`;
                    }
                }
            }
        }

        if (activity?.conditionId) {
            const slugPart = (rawTitle || 'Unknown').substring(0, 30);
            return `CID-${activity.conditionId}-${slugPart}`;
        }

        if (!rawTitle) return 'Unknown';
        
        // Try to extract crypto symbol and timeframe
        const titleLower = rawTitle.toLowerCase();
        
        // Check for Bitcoin patterns
        if (titleLower.includes('bitcoin') || titleLower.includes('btc')) {
            const match = rawTitle.match(/(\d+)\s*min/i);
            if (match) {
                return `BTC-${match[1]}min`;
            }
            // Check for other timeframes
            const hourMatch = rawTitle.match(/(\d+)\s*h/i);
            if (hourMatch) {
                return `BTC-${hourMatch[1]}h`;
            }
            return 'BTC';
        }
        
        // Check for Ethereum patterns
        if (titleLower.includes('ethereum') || titleLower.includes('eth')) {
            const match = rawTitle.match(/(\d+)\s*min/i);
            if (match) {
                return `ETH-${match[1]}min`;
            }
            const hourMatch = rawTitle.match(/(\d+)\s*h/i);
            if (hourMatch) {
                return `ETH-${hourMatch[1]}h`;
            }
            return 'ETH';
        }
        
        // Check for Solana
        if (titleLower.includes('solana') || titleLower.includes('sol')) {
            const match = rawTitle.match(/(\d+)\s*min/i);
            if (match) {
                return `SOL-${match[1]}min`;
            }
            return 'SOL';
        }
        
        // Check for generic crypto patterns: "CRYPTO 15min" or "CRYPTO/USD 15min"
        const cryptoMatch = rawTitle.match(/([A-Z]{2,5})\s*\/?\s*USD?\s*(\d+)\s*min/i);
        if (cryptoMatch) {
            return `${cryptoMatch[1].toUpperCase()}-${cryptoMatch[2]}min`;
        }
        
        // Check for standalone crypto symbols with timeframes
        const symbolMatch = rawTitle.match(/\b([A-Z]{2,5})\b.*?(\d+)\s*min/i);
        if (symbolMatch) {
            return `${symbolMatch[1].toUpperCase()}-${symbolMatch[2]}min`;
        }

        // If slug contains date/time segments, keep more of it for uniqueness
        if (activity?.slug) {
            const slugParts = activity.slug.split('-');
            if (slugParts.length >= 3) {
                return slugParts.slice(0, 4).join('-').substring(0, 40);
            }
            return activity.slug.substring(0, 40);
        }
        if (activity?.eventSlug) {
            const slugParts = activity.eventSlug.split('-');
            if (slugParts.length >= 3) {
                return slugParts.slice(0, 4).join('-').substring(0, 40);
            }
            return activity.eventSlug.substring(0, 40);
        }
        
        // Fallback: use first meaningful words (limit to 25 chars)
        const parts = rawTitle.split(/\s+/).filter((p: string) => p.length > 0);
        if (parts.length >= 2) {
            return `${parts[0].substring(0, 10)}-${parts[1].substring(0, 10)}`.substring(0, 25);
        }
        if (parts.length > 0) {
            return parts[0].substring(0, 25);
        }
        
        return 'Unknown';
    }

    /**
     * Extract time window from market name (e.g., "10:15-10:30" or "10:30-10:45")
     */
    private extractTimeWindow(marketName: string): string | null {
        // Look for patterns like "10:15-10:30", "10:30-10:45", "10:15AM-10:30AM", "10:15 AM - 10:30 AM", etc.
        // Also handle formats like "December 23, 10:15AM-10:30AM ET"
        const timePatterns = [
            /(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*[-–]\s*(\d{1,2}:\d{2}(?:\s*[AP]M)?)/i,
            /(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/i, // Without AM/PM
        ];
        
        for (const pattern of timePatterns) {
            const match = marketName.match(pattern);
            if (match) {
                return `${match[1].trim()}-${match[2].trim()}`;
            }
        }
        return null;
    }

    /**
     * Check if a time-window market has passed (e.g., "10:30-10:45" where current time > 10:45)
     * Assumes times are in ET/EST timezone
     */
    private isTimeWindowMarketPassed(marketName: string): boolean {
        const timeWindow = this.extractTimeWindow(marketName);
        if (!timeWindow) {
            return false; // Not a time-window market, can't determine if passed
        }

        try {
            // Extract end time (e.g., "10:45" from "10:30-10:45")
            const parts = timeWindow.split(/[-–]/);
            if (parts.length !== 2) {
                return false;
            }

            const endTimeStr = parts[1].trim();
            
            // Parse the end time
            // Handle formats like "10:45", "10:45AM", "10:45 PM", etc.
            const hasAMPM = /[AP]M/i.test(endTimeStr);
            const cleaned = endTimeStr.replace(/\s*[AP]M/i, '').trim();
            const timeParts = cleaned.split(':');
            
            if (timeParts.length !== 2) {
                return false;
            }

            let hours = parseInt(timeParts[0], 10);
            const minutes = parseInt(timeParts[1], 10);
            
            if (isNaN(hours) || isNaN(minutes)) {
                return false;
            }

            // Handle 12-hour format
            if (hasAMPM) {
                const isPM = /PM/i.test(endTimeStr);
                if (isPM && hours !== 12) {
                    hours += 12;
                } else if (!isPM && hours === 12) {
                    hours = 0;
                }
            }

            // Get current time in ET/EST
            // Use Intl.DateTimeFormat to get ET time (handles EST/EDT automatically)
            const now = new Date();
            const etFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });
            
            // Format as "HH:mm" and parse
            const etTimeStr = etFormatter.format(now);
            const [etHoursStr, etMinutesStr] = etTimeStr.split(':');
            const etHours = parseInt(etHoursStr || '0', 10);
            const etMinutes = parseInt(etMinutesStr || '0', 10);
            const currentTotalMinutes = etHours * 60 + etMinutes;
            const endTotalMinutes = hours * 60 + minutes;

            // Check if end time has passed today
            // If end time is early (e.g., 1:00 AM) and current time is late (e.g., 11:00 PM),
            // assume the market ended yesterday, so it's definitely passed
            if (endTotalMinutes < 6 * 60 && currentTotalMinutes > 18 * 60) {
                // End time is before 6 AM and current time is after 6 PM - market likely ended yesterday
                return true;
            }

            // Otherwise, check if current time is past end time
            return currentTotalMinutes > endTotalMinutes;
        } catch (e) {
            // If we can't parse, assume market hasn't passed (safer to show than hide)
            return false;
        }
    }

    /**
     * Get base market name without time window (e.g., "Bitcoin Up or Down" from "Bitcoin Up or Down - 10:15-10:30")
     */
    private getBaseMarketName(marketName: string): string {
        const timeWindow = this.extractTimeWindow(marketName);
        if (timeWindow) {
            // Remove the time window part
            return marketName.replace(new RegExp(`\\s*[-–]\\s*${timeWindow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), '').trim();
        }
        return marketName;
    }

    /**
     * Remove older ETH-UpDown-15, ETH-UpDown-1h, BTC-UpDown-15, or BTC-UpDown-1h markets when a new one appears
     * For 15min markets: Remove older markets in the same category (only keep the newest)
     * For hourly markets: Only remove if we're at max markets limit, otherwise allow multiple hours to coexist
     */
    private removeOlderUpDown15Markets(newMarketKey: string, newMarketActivity: any): void {
        // Check if this is an UpDown market (15min or hourly)
        const isUpDown15 = newMarketKey === 'ETH-UpDown-15' || newMarketKey === 'BTC-UpDown-15';
        const isUpDown1h = newMarketKey.startsWith('ETH-UpDown-1h') || newMarketKey.startsWith('BTC-UpDown-1h');
        
        if (!isUpDown15 && !isUpDown1h) {
            return;
        }
        
        // Extract category for comparison (BTC-UpDown-15, BTC-UpDown-1h, etc.)
        let newCategory: string;
        if (isUpDown15) {
            newCategory = newMarketKey; // e.g., "BTC-UpDown-15"
        } else {
            // For hourly markets, extract base category (e.g., "BTC-UpDown-1h" from "BTC-UpDown-1h-6")
            newCategory = newMarketKey.split('-').slice(0, 3).join('-'); // "BTC-UpDown-1h"
        }

        const marketsToRemove: string[] = [];
        const newMarketTimestamp = newMarketActivity?.timestamp 
            ? (newMarketActivity.timestamp * 1000) // Convert from seconds to milliseconds
            : Date.now();

        // For 15min markets: Always remove older ones in the same category (only one 15min market per category)
        // For hourly markets: Only remove if we're at or over the max limit
        const shouldEnforceSingleMarket = isUpDown15 || (isUpDown1h && this.markets.size >= this.maxMarkets);

        // Check all existing markets to find UpDown markets of the same category
        for (const [key, market] of this.markets.entries()) {
            // Skip if it's the same key - we'll update it, not remove it
            if (key === newMarketKey) {
                continue;
            }

            // Check if this existing market is in the same category
            let existingCategory: string | null = null;
            if (key.startsWith('ETH-UpDown-15') || key.startsWith('BTC-UpDown-15')) {
                existingCategory = key.split('-').slice(0, 3).join('-'); // "BTC-UpDown-15"
            } else if (key.startsWith('ETH-UpDown-1h') || key.startsWith('BTC-UpDown-1h')) {
                existingCategory = key.split('-').slice(0, 3).join('-'); // "BTC-UpDown-1h"
            } else {
                // Try to get category from market name
                const existingUpDownType = this.getUpDown15MarketType({
                    slug: market.marketName,
                    title: market.marketName,
                    eventSlug: market.marketName,
                });
                if (existingUpDownType) {
                    existingCategory = existingUpDownType;
                }
            }

            if (existingCategory === newCategory) {
                // Found a market in the same category
                if (shouldEnforceSingleMarket) {
                    // For 15min markets or when at max limit, remove older markets in same category
                    if (market.lastUpdate < newMarketTimestamp) {
                        marketsToRemove.push(key);
                    }
                }
                // For hourly markets when under max limit, allow multiple hours to coexist
            }
        }

        // Remove older markets
        for (const key of marketsToRemove) {
            this.markets.delete(key);
        }
    }

    /**
     * Remove previous time window markets when a new one starts
     */
    private removePreviousTimeWindow(newMarket: MarketStats): void {
        const newTimeWindow = this.extractTimeWindow(newMarket.marketName);
        if (!newTimeWindow) {
            return; // Not a time-window market
        }

        const baseName = this.getBaseMarketName(newMarket.marketName);
        
        // Find markets with the same base name but different (earlier) time windows
        const marketsToRemove: string[] = [];
        
        for (const [key, market] of this.markets.entries()) {
            if (key === newMarket.marketKey) {
                continue; // Don't remove the new market
            }

            const marketBaseName = this.getBaseMarketName(market.marketName);
            if (marketBaseName === baseName) {
                const marketTimeWindow = this.extractTimeWindow(market.marketName);
                if (marketTimeWindow && marketTimeWindow !== newTimeWindow) {
                    // Extract start times to compare
                    const newStart = newTimeWindow.split(/[-–]/)[0].trim();
                    const marketStart = marketTimeWindow.split(/[-–]/)[0].trim();
                    
                    // Parse times (handle formats like "10:15", "10:15AM", "10:15 AM", etc.)
                    const parseTime = (timeStr: string): number | null => {
                        try {
                            const cleaned = timeStr.replace(/\s*[AP]M/i, '').trim();
                            const parts = cleaned.split(':');
                            if (parts.length !== 2) return null;
                            
                            let hours = parseInt(parts[0], 10);
                            const minutes = parseInt(parts[1], 10);
                            
                            if (isNaN(hours) || isNaN(minutes)) return null;
                            
                            // Handle 12-hour format (if AM/PM was present, but we already removed it)
                            // For now, assume 24-hour format or that hours are already correct
                            return hours * 60 + minutes;
                        } catch (e) {
                            return null;
                        }
                    };

                    const newStartMinutes = parseTime(newStart);
                    const marketStartMinutes = parseTime(marketStart);
                    
                    // Only remove if we can successfully parse both times
                    if (newStartMinutes !== null && marketStartMinutes !== null) {
                        // Remove markets with earlier start times (previous time windows)
                        // Also handle wrap-around (e.g., 11:45 -> 12:00, but 12:00 is later)
                        if (marketStartMinutes < newStartMinutes) {
                            marketsToRemove.push(key);
                        }
                    }
                }
            }
        }

        // Remove the previous time window markets
        for (const key of marketsToRemove) {
            this.markets.delete(key);
        }
    }

    /**
     * Determine if outcome is UP or DOWN
     */
    private isUpOutcome(activity: any): boolean {
        // Primary method: use outcomeIndex (0 = UP/YES, 1 = DOWN/NO typically)
        if (activity.outcomeIndex !== undefined) {
            return activity.outcomeIndex === 0;
        }
        
        // Fallback: check outcome and asset strings
        const outcome = (activity.outcome || '').toLowerCase();
        const asset = (activity.asset || '').toLowerCase();
        
        // Check for UP indicators
        if (outcome.includes('up') || 
            outcome.includes('higher') ||
            outcome.includes('above') ||
            outcome.includes('yes') ||
            asset.includes('yes') ||
            asset.includes('up')) {
            return true;
        }
        
        // Check for DOWN indicators
        if (outcome.includes('down') ||
            outcome.includes('lower') ||
            outcome.includes('below') ||
            outcome.includes('no') ||
            asset.includes('no') ||
            asset.includes('down')) {
            return false;
        }
        
        // Default: assume first outcome is UP
        return true;
    }

    /**
     * Close old markets in the same category when a new one opens
     * Only closes the oldest market in the same category, not all of them
     * For hourly markets: Only close if we're at max limit, otherwise allow multiple hours to coexist
     * This allows different categories to coexist up to the max limit
     */
    private async closeOldMarketsInCategory(newMarket: MarketStats, newCategory: string | null): Promise<void> {
        if (!newCategory) return;

        // Check if this is an hourly market category
        const isHourlyCategory = newCategory === 'BTC-UpDown-1h' || newCategory === 'ETH-UpDown-1h';
        
        // For hourly markets, only close old ones if we're at or over the max limit
        // Otherwise, allow multiple hourly markets to coexist
        if (isHourlyCategory && this.markets.size < this.maxMarkets) {
            return; // Don't close hourly markets if we have room
        }

        // Find all markets in the same category (excluding the new one)
        const marketsInCategory: Array<{ key: string; market: MarketStats }> = [];
        
        for (const [key, market] of this.markets.entries()) {
            if (key === newMarket.marketKey) continue;
            
            // Check if this market is in the same category
            if (market.category === newCategory) {
                marketsInCategory.push({ key, market });
            }
        }

        // Only close the oldest market in the same category
        // Sort by lastUpdate (oldest first) and take only the oldest one
        if (marketsInCategory.length > 0) {
            marketsInCategory.sort((a, b) => a.market.lastUpdate - b.market.lastUpdate);
            const oldestMarket = marketsInCategory[0];
            
            // Record profit from point of new market opening
            await this.recordProfitAtMarketSwitch(oldestMarket.market, newMarket);
            
            // Remove from tracking
            this.markets.delete(oldestMarket.key);
            
            // Trigger position closing callback if set
            if (this.onMarketCloseCallback) {
                try {
                    await this.onMarketCloseCallback(oldestMarket.market);
                } catch (error) {
                    console.error(`Error closing positions for market ${oldestMarket.key}:`, error);
                }
            }
        }
    }

    /**
     * Record profit from point of new market opening
     * This records PnL for a market at the time a new market opens
     */
    private async recordProfitAtNewMarketOpening(market: MarketStats, newMarket: MarketStats, isSwitching: boolean = false): Promise<void> {
        // Fetch current prices at the time of new market opening
        const finalPrices = await this.fetchFinalPrices(market);
        
        const totalInvested = market.investedUp + market.investedDown;
        
        // Skip if no investment
        if (totalInvested === 0) {
            return;
        }
        
        let finalValueUp = 0;
        let finalValueDown = 0;
        let pnlUp = 0;
        let pnlDown = 0;

        const finalPriceUp = finalPrices.priceUp ?? market.currentPriceUp ?? 0;
        const finalPriceDown = finalPrices.priceDown ?? market.currentPriceDown ?? 0;

        if (market.sharesUp > 0 && finalPriceUp > 0) {
            finalValueUp = market.sharesUp * finalPriceUp;
            pnlUp = finalValueUp - market.investedUp;
        }

        if (market.sharesDown > 0 && finalPriceDown > 0) {
            finalValueDown = market.sharesDown * finalPriceDown;
            pnlDown = finalValueDown - market.investedDown;
        }

        const totalFinalValue = finalValueUp + finalValueDown;
        const totalPnl = pnlUp + pnlDown;
        const pnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

        // Determine outcome
        let outcome = 'Unknown';
        if (finalPriceUp >= 0.99) {
            outcome = 'UP Won';
        } else if (finalPriceUp <= 0.01) {
            outcome = 'UP Lost';
        } else if (finalPriceDown >= 0.99) {
            outcome = 'DOWN Won';
        } else if (finalPriceDown <= 0.01) {
            outcome = 'DOWN Lost';
        } else if (totalPnl > 0) {
            outcome = 'Profit';
        } else if (totalPnl < 0) {
            outcome = 'Loss';
        }

        // Log to CSV
        const timestamp = Date.now();
        const date = new Date().toISOString();
        const timeBreakdown = getTimestampBreakdown(timestamp);
        const marketKeyDisplay = isSwitching 
            ? `${market.marketKey}->${newMarket.marketKey}`
            : market.marketKey;
        const marketNameDisplay = isSwitching
            ? `"${market.marketName.replace(/"/g, '""')} (New market: ${newMarket.marketName.replace(/"/g, '""')})"`
            : `"${market.marketName.replace(/"/g, '""')} (Snapshot at new market: ${newMarket.marketName.replace(/"/g, '""')})"`;
        
        const row = [
            timestamp,
            date,
            timeBreakdown.year,
            timeBreakdown.month,
            timeBreakdown.day,
            timeBreakdown.hour,
            timeBreakdown.minute,
            timeBreakdown.second,
            timeBreakdown.millisecond,
            marketKeyDisplay,
            marketNameDisplay,
            market.conditionId || '',
            market.investedUp.toFixed(2),
            market.investedDown.toFixed(2),
            totalInvested.toFixed(2),
            market.sharesUp.toFixed(4),
            market.sharesDown.toFixed(4),
            finalPriceUp.toFixed(4),
            finalPriceDown.toFixed(4),
            finalValueUp.toFixed(2),
            finalValueDown.toFixed(2),
            totalFinalValue.toFixed(2),
            pnlUp.toFixed(2),
            pnlDown.toFixed(2),
            totalPnl.toFixed(2),
            pnlPercent.toFixed(2),
            market.tradesUp,
            market.tradesDown,
            outcome,
            isSwitching ? 'Market Switch' : 'New Market Snapshot'
        ].join(',');

        try {
            fs.appendFileSync(this.csvFilePath, row + '\n', 'utf8');
        } catch (error) {
            console.error(`Failed to write market PnL to CSV: ${error}`);
        }
    }

    /**
     * Record profit from point of new market opening (legacy method name for backward compatibility)
     */
    private async recordProfitAtMarketSwitch(oldMarket: MarketStats, newMarket: MarketStats): Promise<void> {
        await this.recordProfitAtNewMarketOpening(oldMarket, newMarket, true);
    }

    /**
     * Record PnL for all active markets when a new market opens
     */
    private async recordAllMarketsPnLAtNewMarketOpening(newMarket: MarketStats): Promise<void> {
        // Record PnL for all existing markets (except the new one)
        const marketsToRecord = Array.from(this.markets.values()).filter(
            m => m.marketKey !== newMarket.marketKey
        );

        // Record PnL for each market
        for (const market of marketsToRecord) {
            // Only record if there's actual investment
            if (market.investedUp > 0 || market.investedDown > 0) {
                await this.recordProfitAtNewMarketOpening(market, newMarket, false);
            }
        }
    }

    /**
     * Limit markets to maximum count, removing oldest ones
     */
    private async enforceMaxMarkets(): Promise<void> {
        if (this.markets.size <= this.maxMarkets) {
            return;
        }

        // Sort markets by lastUpdate (oldest first)
        const sortedMarkets = Array.from(this.markets.entries())
            .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate);

        // Remove oldest markets until we're at max
        const toRemove = sortedMarkets.slice(0, this.markets.size - this.maxMarkets);
        
        for (const [key, market] of toRemove) {
            // Record profit before removing
            await this.logClosedMarketPnL(market);
            
            // Remove from tracking
            this.markets.delete(key);
            
            // Trigger position closing callback if set
            if (this.onMarketCloseCallback) {
                try {
                    await this.onMarketCloseCallback(market);
                } catch (error) {
                    console.error(`Error closing positions for market ${key}:`, error);
                }
            }
        }
    }

    /**
     * Process a new trade
     */
    async processTrade(activity: any): Promise<void> {
        // Only process 15min or hourly markets
        if (!this.is15MinOrHourlyMarket(activity)) {
            return; // Skip non-15min/hourly markets
        }

        // Create unique trade identifier to prevent double-counting
        // Use transactionHash + asset + side as unique key
        const tradeId = activity.transactionHash 
            ? `${activity.transactionHash}:${activity.asset}:${activity.side || 'BUY'}`
            : `${activity.timestamp}:${activity.asset}:${activity.side || 'BUY'}`;
        
        // Skip if we've already processed this exact trade
        if (this.processedTrades.has(tradeId)) {
            return; // Already processed this trade, skip to prevent double-counting
        }

        const marketKey = this.extractMarketKey(activity);
        const isUp = this.isUpOutcome(activity);
        const shares = parseFloat(activity.size || '0');
        const invested = parseFloat(activity.usdcSize || '0');
        const side = activity.side?.toUpperCase() || 'BUY';
        const category = this.extractMarketCategory(activity);

        const isNewMarket = !this.markets.has(marketKey);
        
        // Remove older UpDown-15 markets before adding/updating
        // Always check, even if market exists, to catch older markets with different keys
        this.removeOlderUpDown15Markets(marketKey, activity);
        
        let market = this.markets.get(marketKey);
        
        if (!market) {
            market = {
                marketKey,
                marketName: activity.title || activity.slug || marketKey,
                sharesUp: 0,
                sharesDown: 0,
                investedUp: 0,
                investedDown: 0,
                totalCostUp: 0,
                totalCostDown: 0,
                tradesUp: 0,
                tradesDown: 0,
                lastUpdate: Date.now(),
                endDate: activity.endDate ? activity.endDate * 1000 : undefined, // Convert to milliseconds
                conditionId: activity.conditionId,
                assetUp: isUp ? activity.asset : undefined,
                assetDown: !isUp ? activity.asset : undefined,
                marketOpenTime: Date.now(),
                category: category || undefined,
            };
            this.markets.set(marketKey, market);
            
            // Remove previous time window markets when a new one starts
            this.removePreviousTimeWindow(market);
            
            // Record PnL for ALL existing markets at the time of new market opening
            // This captures the PnL snapshot of all markets when a new one opens
            await this.recordAllMarketsPnLAtNewMarketOpening(market);
            
            // Close old markets in the same category
            if (category) {
                await this.closeOldMarketsInCategory(market, category);
            }
            
            // Enforce max markets limit
            await this.enforceMaxMarkets();
            
            // Force immediate display update for new markets
            if (isNewMarket) {
                this.lastDisplayTime = 0; // Force display on next call
            }

            // If the first trade is SELL, still register the market but don't accumulate
            if (side !== 'BUY') {
                return;
            }
        } else {
            // Update endDate and conditionId if available and not already set
            if (activity.endDate && !market.endDate) {
                market.endDate = activity.endDate * 1000; // Convert to milliseconds
            }
            if (activity.conditionId && !market.conditionId) {
                market.conditionId = activity.conditionId;
            }
            // Store asset IDs for UP and DOWN outcomes
            if (isUp && activity.asset && !market.assetUp) {
                market.assetUp = activity.asset;
            }
            if (!isUp && activity.asset && !market.assetDown) {
                market.assetDown = activity.asset;
            }
            // Update category if not set
            if (!market.category && category) {
                market.category = category;
            }
        }

        const price = parseFloat(activity.price || '0');
        const cost = shares * price; // Total cost for this trade

        // Only accumulate on BUY; SELL just registers market presence
        if (side === 'BUY') {
            if (isUp) {
                market.sharesUp += shares;
                market.investedUp += invested;
                market.totalCostUp += cost;
                market.tradesUp += 1;
            } else {
                market.sharesDown += shares;
                market.investedDown += invested;
                market.totalCostDown += cost;
                market.tradesDown += 1;
            }
            
            // Mark this trade as processed to prevent double-counting
            this.processedTrades.add(tradeId);
        } else {
            // For SELL trades, also mark as processed but don't count
            this.processedTrades.add(tradeId);
        }

        market.lastUpdate = Date.now();
    }

    /**
     * Fetch current prices for market assets
     * Uses positions from tracked traders to get current prices
     */
    private async fetchCurrentPrices(market: MarketStats): Promise<void> {
        const now = Date.now();

        // Only fetch from API every 10 seconds to avoid too many API calls
        const shouldFetchFromAPI = !market.lastPriceUpdate || (now - market.lastPriceUpdate >= 10000);

        if (shouldFetchFromAPI) {
            try {
                // Fetch prices from positions of tracked traders
                // This gives us the most accurate current prices
                for (const traderAddress of ENV.USER_ADDRESSES) {
                    try {
                        const positions = await fetchData(
                            `https://data-api.polymarket.com/positions?user=${traderAddress}`
                        ).catch(() => null);

                        if (Array.isArray(positions)) {
                            for (const pos of positions) {
                                // Match by asset ID
                                if (market.assetUp && pos.asset === market.assetUp && pos.curPrice !== undefined) {
                                    market.currentPriceUp = parseFloat(pos.curPrice);
                                }
                                if (market.assetDown && pos.asset === market.assetDown && pos.curPrice !== undefined) {
                                    market.currentPriceDown = parseFloat(pos.curPrice);
                                }
                            }
                        }
                    } catch (e) {
                        // Continue to next trader
                    }
                }

                market.lastPriceUpdate = now;
            } catch (e) {
                // Silently fail - prices will be updated on next cycle
            }
        }

        // Always log prices to CSV for live chart (every time this method is called)
        // Use 0 as fallback if prices haven't been fetched yet
        const priceUp = market.currentPriceUp ?? 0;
        const priceDown = market.currentPriceDown ?? 0;

        // Only log if we have actual prices (not both zero)
        if (priceUp > 0 || priceDown > 0) {
            const marketSlug = market.marketName || market.marketKey || '';
            priceStreamLogger.logPrice(
                marketSlug,
                market.marketName,
                priceUp,
                priceDown
            );
        }
    }

    /**
     * Display market statistics
     */
    async displayStats(): Promise<void> {
        // Prevent concurrent display updates
        if (this.isDisplaying) {
            return;
        }
        
        const now = Date.now();
        const timeSinceLastDisplay = now - this.lastDisplayTime;
        
        // Always update if new market detected, otherwise respect interval
        const hasNewMarket = this.markets.size !== this.lastMarketCount;
        
        // Force update if new market detected, or if enough time has passed
        // Also force update if lastDisplayTime was reset to 0 (forced refresh)
        const shouldUpdate = hasNewMarket || 
                            timeSinceLastDisplay >= this.displayInterval || 
                            this.lastDisplayTime === 0;
        
        if (!shouldUpdate) {
            return;
        }
        
        // Set lock
        this.isDisplaying = true;
        
        try {
            // Update tracking variables
            const previousMarketCount = this.lastMarketCount;
            this.lastDisplayTime = now;
            this.lastMarketCount = this.markets.size;

        if (this.markets.size === 0) {
            // Show empty state if we had markets before but now have none
            if (previousMarketCount > 0) {
                // Use ANSI escape codes for reliable screen clearing
                process.stdout.write('\x1b[2J\x1b[0f');
                console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
                console.log(chalk.cyan.bold('  📊 MARKET TRACKING SUMMARY'));
                console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
                console.log('');
                console.log(chalk.gray('  No active markets to display'));
                console.log('');
            }
            return; // Lock will be released in finally block
        }

        // Filter out closed markets (where endDate has passed or time window has passed)
        // Keep markets stable - only remove if they're actually closed
        // Fallback: if market hasn't been updated in 7 days, consider it stale/closed
        const STALE_MARKET_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
        
        // Track markets before filtering to detect changes
        const marketsBeforeFilter = this.markets.size;
        
        const activeMarkets = Array.from(this.markets.values()).filter((m) => {
            // If market has an endDate and it has passed, consider it closed
            if (m.endDate && now > m.endDate) {
                return false; // Market is closed
            }
            // Check if time-window market has passed (e.g., "10:30-10:45" where current time > 10:45)
            if (this.isTimeWindowMarketPassed(m.marketName)) {
                return false; // Market time window has passed
            }
            // Fallback: if market hasn't been updated in a very long time, consider it stale
            if (now - m.lastUpdate > STALE_MARKET_THRESHOLD) {
                return false; // Market is stale/closed
            }
            // Keep all other markets (stable dashboard)
            return true;
        });

        // Remove closed/stale markets from tracking and log PnL
        const closedMarkets: MarketStats[] = [];
        for (const [key, value] of this.markets.entries()) {
            const isClosed = value.endDate && now > value.endDate;
            const isTimeWindowPassed = this.isTimeWindowMarketPassed(value.marketName);
            const isStale = now - value.lastUpdate > STALE_MARKET_THRESHOLD;
            if (isClosed || isTimeWindowPassed || isStale) {
                // Only log markets that have actual investment (not just stale with no trades)
                if (value.investedUp > 0 || value.investedDown > 0) {
                    closedMarkets.push(value);
                }
                this.markets.delete(key);
            }
        }

        // Log closed markets to CSV (async, don't wait)
        if (closedMarkets.length > 0) {
            // Log each closed market
            closedMarkets.forEach(market => {
                this.logClosedMarketPnL(market).catch(err => {
                    console.error(`Failed to log closed market ${market.marketKey}: ${err}`);
                });
            });
        }

        // Update market count after filtering
        this.lastMarketCount = this.markets.size;

        // Always display if we have active markets, even if count didn't change
        // (markets might have been updated with new trades)
        if (activeMarkets.length === 0) {
            // Only show empty state if we had markets before
            if (marketsBeforeFilter > 0) {
                // Use ANSI escape codes for reliable screen clearing
                process.stdout.write('\x1b[2J\x1b[0f');
                console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
                console.log(chalk.cyan.bold('  📊 MARKET TRACKING SUMMARY'));
                console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
                console.log('');
                console.log(chalk.gray('  No active markets to display'));
                console.log('');
            }
            return; // Lock will be released in finally block
        }

        // Fetch current prices for all active markets (in parallel, but limit concurrency)
        const pricePromises = activeMarkets.map(m => this.fetchCurrentPrices(m));
        await Promise.allSettled(pricePromises);

        // Sort markets by total invested (descending) and limit to maxMarkets
        const sortedMarkets = activeMarkets
            .sort((a, b) => {
                const totalA = a.investedUp + a.investedDown;
                const totalB = b.investedUp + b.investedDown;
                return totalB - totalA;
            })
            .slice(0, this.maxMarkets); // Only show top 4 markets

        // Build entire output as string first to prevent partial prints
        const outputLines: string[] = [];

        // Show mode header based on display mode or ENV setting
        const isWatchMode = ENV.TRACK_ONLY_MODE;
        let modeHeader: string;
        if (this.displayMode === 'PAPER') {
            modeHeader = '📊 PAPER MODE';
        } else if (this.displayMode === 'WATCH' || isWatchMode) {
            modeHeader = '👀 WATCH MODE';
        } else {
            modeHeader = '📊 TRADING MODE';
        }
        
        outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        outputLines.push(chalk.cyan.bold(`  ${modeHeader} - TRADER MARKET TRACKING`));
        if (ENV.USER_ADDRESSES.length > 0) {
            if (ENV.USER_ADDRESSES.length === 1) {
                const addr = ENV.USER_ADDRESSES[0];
                outputLines.push(chalk.gray(`  Watching: ${chalk.white(addr)}`));
                outputLines.push(chalk.gray(`  Active Markets: ${sortedMarkets.length}/${this.maxMarkets} | All trades verified from target wallet`));
            } else {
                outputLines.push(chalk.gray(`  Watching: ${ENV.USER_ADDRESSES.length} traders`));
                ENV.USER_ADDRESSES.forEach((addr, idx) => {
                    outputLines.push(chalk.gray(`    ${idx + 1}. ${addr}`));
                });
                outputLines.push(chalk.gray(`  Active Markets: ${sortedMarkets.length}/${this.maxMarkets}`));
            }
        }
        outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        outputLines.push(''); // Empty line

        // Calculate totals across all markets
        let totalInvestedAll = 0;
        let totalValueAll = 0;
        let totalPnlAll = 0;
        let totalTradesAll = 0;

        for (const market of sortedMarkets) {
            const totalInvested = market.investedUp + market.investedDown;
            const upPercent = totalInvested > 0 ? (market.investedUp / totalInvested) * 100 : 0;
            const downPercent = totalInvested > 0 ? (market.investedDown / totalInvested) * 100 : 0;

            // Calculate average prices
            const avgPriceUp = market.sharesUp > 0 ? market.totalCostUp / market.sharesUp : 0;
            const avgPriceDown = market.sharesDown > 0 ? market.totalCostDown / market.sharesDown : 0;
            
            // Calculate unrealized PnL
            let currentValueUp = 0;
            let currentValueDown = 0;
            let pnlUp = 0;
            let pnlDown = 0;
            let totalPnl = 0;

            if (market.currentPriceUp !== undefined && market.sharesUp > 0) {
                currentValueUp = market.sharesUp * market.currentPriceUp;
                pnlUp = currentValueUp - market.investedUp;
            }

            if (market.currentPriceDown !== undefined && market.sharesDown > 0) {
                currentValueDown = market.sharesDown * market.currentPriceDown;
                pnlDown = currentValueDown - market.investedDown;
            }

            totalPnl = pnlUp + pnlDown;
            
            // Accumulate totals
            totalInvestedAll += totalInvested;
            totalValueAll += (currentValueUp + currentValueDown);
            totalPnlAll += totalPnl;
            totalTradesAll += (market.tradesUp + market.tradesDown);
            
            // Compact display format
            const marketNameDisplay = market.marketName.length > 50 
                ? market.marketName.substring(0, 47) + '...' 
                : market.marketName;
            
            outputLines.push(chalk.yellow.bold(`┌─ ${market.marketKey}`));
            outputLines.push(chalk.gray(`│  ${marketNameDisplay}`));
            
            // UP line - compact
            const upLine = `│  ${chalk.green('📈 UP')}: ${market.sharesUp.toFixed(2)} shares | $${market.investedUp.toFixed(2)} @ $${avgPriceUp.toFixed(4)}`;
            if (market.currentPriceUp !== undefined) {
                const pnlColor = pnlUp >= 0 ? chalk.green : chalk.red;
                const pnlSign = pnlUp >= 0 ? '+' : '';
                const pnlPercent = market.investedUp > 0 ? ((pnlUp / market.investedUp) * 100).toFixed(1) : '0.0';
                outputLines.push(`${upLine} | Now: $${market.currentPriceUp.toFixed(4)} | ${pnlColor(`${pnlSign}$${pnlUp.toFixed(2)} (${pnlPercent}%)`)} | ${market.tradesUp} trades`);
            } else {
                outputLines.push(`${upLine} | ${market.tradesUp} trades`);
            }
            
            // DOWN line - compact
            const downLine = `│  ${chalk.red('📉 DOWN')}: ${market.sharesDown.toFixed(2)} shares | $${market.investedDown.toFixed(2)} @ $${avgPriceDown.toFixed(4)}`;
            if (market.currentPriceDown !== undefined) {
                const pnlColor = pnlDown >= 0 ? chalk.green : chalk.red;
                const pnlSign = pnlDown >= 0 ? '+' : '';
                const pnlPercent = market.investedDown > 0 ? ((pnlDown / market.investedDown) * 100).toFixed(1) : '0.0';
                outputLines.push(`${downLine} | Now: $${market.currentPriceDown.toFixed(4)} | ${pnlColor(`${pnlSign}$${pnlDown.toFixed(2)} (${pnlPercent}%)`)} | ${market.tradesDown} trades`);
            } else {
                outputLines.push(`${downLine} | ${market.tradesDown} trades`);
            }
            
            // Summary line - compact
            const totalCurrentValue = currentValueUp + currentValueDown;
            const totalPnlColor = totalPnl >= 0 ? chalk.green : chalk.red;
            const totalPnlSign = totalPnl >= 0 ? '+' : '';
            const totalPnlPercent = totalInvested > 0 ? ((totalPnl / totalInvested) * 100).toFixed(1) : '0.0';
            
            if (totalPnl !== 0 || (market.currentPriceUp !== undefined || market.currentPriceDown !== undefined)) {
                outputLines.push(chalk.cyan(`│  💰 Invested: $${totalInvested.toFixed(2)} | Value: $${totalCurrentValue.toFixed(2)} | ${totalPnlColor(`PnL: ${totalPnlSign}$${totalPnl.toFixed(2)} (${totalPnlPercent}%)`)}`));
            } else {
                outputLines.push(chalk.cyan(`│  💰 Total Invested: $${totalInvested.toFixed(2)}`));
            }
            
            // Visual bar - compact
            const barLength = 30;
            const upBars = Math.round((upPercent / 100) * barLength);
            const downBars = barLength - upBars;
            const upBar = chalk.green('█'.repeat(upBars));
            const downBar = chalk.red('█'.repeat(downBars));
            outputLines.push(chalk.gray(`│  [${upBar}${downBar}] ${upPercent.toFixed(1)}% UP / ${downPercent.toFixed(1)}% DOWN`));
            outputLines.push(chalk.gray('└' + '─'.repeat(78)));
            outputLines.push(''); // Empty line between markets
        }

        // Display summary across all markets
        outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        outputLines.push(chalk.yellow.bold('  📊 PORTFOLIO SUMMARY (All Markets)'));
        const totalPnlColor = totalPnlAll >= 0 ? chalk.green : chalk.red;
        const totalPnlSign = totalPnlAll >= 0 ? '+' : '';
        const totalPnlPercent = totalInvestedAll > 0 ? ((totalPnlAll / totalInvestedAll) * 100).toFixed(2) : '0.00';
        
        outputLines.push(chalk.cyan(`  Total Invested: ${chalk.white(`$${totalInvestedAll.toFixed(2)}`)}`));
        outputLines.push(chalk.cyan(`  Current Value:  ${chalk.white(`$${totalValueAll.toFixed(2)}`)}`));
        outputLines.push(chalk.cyan(`  Total PnL:      ${totalPnlColor(`${totalPnlSign}$${totalPnlAll.toFixed(2)} (${totalPnlSign}${totalPnlPercent}%)`)}`));
        outputLines.push(chalk.cyan(`  Total Trades:   ${chalk.white(totalTradesAll.toString())}`));
        outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        outputLines.push(''); // Empty line at end

        // Clear screen and print everything at once
        process.stdout.write('\x1b[2J\x1b[H');
        for (const line of outputLines) {
            console.log(line);
        }
        } finally {
            // Release lock
            this.isDisplaying = false;
        }
    }

    /**
     * Set display mode for header (WATCH, TRADING, or PAPER)
     */
    setDisplayMode(mode: 'WATCH' | 'TRADING' | 'PAPER'): void {
        this.displayMode = mode;
    }

    /**
     * Force immediate display update on next call to displayStats()
     */
    forceDisplayUpdate(): void {
        this.lastDisplayTime = 0;
    }

    /**
     * Get all market stats (for external use)
     */
    getStats(): MarketStats[] {
        return Array.from(this.markets.values());
    }

    /**
     * Clear all stats
     */
    clear(): void {
        this.markets.clear();
    }
}

export default new MarketTracker();

