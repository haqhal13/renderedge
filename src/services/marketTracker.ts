import chalk from 'chalk';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';

interface MarketStats {
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
}

class MarketTracker {
    private markets: Map<string, MarketStats> = new Map();
    private lastDisplayTime = 0;
    // Stable dashboard: update every 2s unless new market forces immediate refresh
    private displayInterval = 2000;
    private lastMarketCount = 0;

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
        
        if (!has15Min) {
            return null;
        }
        
        // Check for UpDown pattern (up/down/updown)
        const hasUpDown = /up.*?down|down.*?up|updown/i.test(rawTitle);
        
        if (hasUpDown || has15Min) {
            // Check for Bitcoin
            if (titleLower.includes('bitcoin') || titleLower.includes('btc') || /^btc/i.test(rawTitle)) {
                return 'BTC-UpDown-15';
            }
            // Check for Ethereum
            if (titleLower.includes('ethereum') || titleLower.includes('eth') || /^eth/i.test(rawTitle)) {
                return 'ETH-UpDown-15';
            }
        }
        
        return null;
    }

    /**
     * Extract market key from activity
     * Priority:
     * 1) conditionId (most stable per market)
     * 2) slug / eventSlug
     * 3) title / asset fallback
     */
    private extractMarketKey(activity: any): string {
        // Check for ETH-UpDown-15 or BTC-UpDown-15 markets first
        const upDown15Type = this.getUpDown15MarketType(activity);
        if (upDown15Type) {
            return upDown15Type; // Normalized key for UpDown-15 markets
        }

        if (activity?.conditionId) {
            const slugPart = (activity?.slug || activity?.eventSlug || activity?.title || '').substring(0, 30);
            return `CID-${activity.conditionId}-${slugPart}`;
        }

        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            'Unknown';

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
     * Remove older ETH-UpDown-15 or BTC-UpDown-15 markets when a new one appears
     * Ensures only the most recent market of each type is kept
     * This checks all existing markets to find any UpDown-15 markets of the same type
     */
    private removeOlderUpDown15Markets(newMarketKey: string, newMarketActivity: any): void {
        // Only process if this is an UpDown-15 market
        if (newMarketKey !== 'ETH-UpDown-15' && newMarketKey !== 'BTC-UpDown-15') {
            return;
        }

        const marketsToRemove: string[] = [];
        const newMarketTimestamp = newMarketActivity?.timestamp 
            ? (newMarketActivity.timestamp * 1000) // Convert from seconds to milliseconds
            : Date.now();

        // Check all existing markets to find UpDown-15 markets of the same type
        for (const [key, market] of this.markets.entries()) {
            // Skip if it's the same key - we'll update it, not remove it
            if (key === newMarketKey) {
                continue;
            }

            // Check if this existing market is also an UpDown-15 market of the same type
            const existingUpDown15Type = this.getUpDown15MarketType({
                slug: market.marketName,
                title: market.marketName,
                eventSlug: market.marketName,
            });

            if (existingUpDown15Type === newMarketKey) {
                // Found an UpDown-15 market of the same type
                // Remove it if it's older than the new market
                // Compare by lastUpdate timestamp
                if (market.lastUpdate < newMarketTimestamp) {
                    marketsToRemove.push(key);
                }
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
     * Process a new trade
     */
    processTrade(activity: any): void {
        const marketKey = this.extractMarketKey(activity);
        const isUp = this.isUpOutcome(activity);
        const shares = parseFloat(activity.size || '0');
        const invested = parseFloat(activity.usdcSize || '0');
        const side = activity.side?.toUpperCase() || 'BUY';

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
            };
            this.markets.set(marketKey, market);
            
            // Remove previous time window markets when a new one starts
            this.removePreviousTimeWindow(market);
            
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
        }

        market.lastUpdate = Date.now();
    }

    /**
     * Fetch current prices for market assets
     * Uses positions from tracked traders to get current prices
     */
    private async fetchCurrentPrices(market: MarketStats): Promise<void> {
        const now = Date.now();
        // Only update prices every 10 seconds to avoid too many API calls
        if (market.lastPriceUpdate && now - market.lastPriceUpdate < 10000) {
            return;
        }

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

    /**
     * Display market statistics
     */
    async displayStats(): Promise<void> {
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
        
        // Update tracking variables
        const previousMarketCount = this.lastMarketCount;
        this.lastDisplayTime = now;
        this.lastMarketCount = this.markets.size;

        if (this.markets.size === 0) {
            // Show empty state if we had markets before but now have none
            if (previousMarketCount > 0) {
                console.clear();
                console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
                console.log(chalk.cyan.bold('  📊 MARKET TRACKING SUMMARY'));
                console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
                console.log('');
                console.log(chalk.gray('  No active markets to display'));
                console.log('');
            }
            return;
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

        // Remove closed/stale markets from tracking
        for (const [key, value] of this.markets.entries()) {
            const isClosed = value.endDate && now > value.endDate;
            const isTimeWindowPassed = this.isTimeWindowMarketPassed(value.marketName);
            const isStale = now - value.lastUpdate > STALE_MARKET_THRESHOLD;
            if (isClosed || isTimeWindowPassed || isStale) {
                this.markets.delete(key);
            }
        }

        // Update market count after filtering
        this.lastMarketCount = this.markets.size;

        // Always display if we have active markets, even if count didn't change
        // (markets might have been updated with new trades)
        if (activeMarkets.length === 0) {
            // Only show empty state if we had markets before
            if (marketsBeforeFilter > 0) {
                console.clear();
                console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
                console.log(chalk.cyan.bold('  📊 MARKET TRACKING SUMMARY'));
                console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
                console.log('');
                console.log(chalk.gray('  No active markets to display'));
                console.log('');
            }
            return;
        }

        // Fetch current prices for all active markets (in parallel, but limit concurrency)
        const pricePromises = activeMarkets.map(m => this.fetchCurrentPrices(m));
        await Promise.allSettled(pricePromises);

        // Stable dashboard: clear screen and redraw
        console.clear();

        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.cyan.bold('  📊 MARKET TRACKING SUMMARY'));
        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(''); // Empty line

        // Sort markets by total invested (descending)
        const sortedMarkets = activeMarkets
            .sort((a, b) => {
                const totalA = a.investedUp + a.investedDown;
                const totalB = b.investedUp + b.investedDown;
                return totalB - totalA;
            });

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
            
            // Compact display format
            const marketNameDisplay = market.marketName.length > 50 
                ? market.marketName.substring(0, 47) + '...' 
                : market.marketName;
            
            console.log(chalk.yellow.bold(`┌─ ${market.marketKey}`));
            console.log(chalk.gray(`│  ${marketNameDisplay}`));
            
            // UP line - compact
            const upLine = `│  ${chalk.green('📈 UP')}: ${market.sharesUp.toFixed(2)} shares | $${market.investedUp.toFixed(2)} @ $${avgPriceUp.toFixed(4)}`;
            if (market.currentPriceUp !== undefined) {
                const pnlColor = pnlUp >= 0 ? chalk.green : chalk.red;
                const pnlSign = pnlUp >= 0 ? '+' : '';
                const pnlPercent = market.investedUp > 0 ? ((pnlUp / market.investedUp) * 100).toFixed(1) : '0.0';
                console.log(`${upLine} | Now: $${market.currentPriceUp.toFixed(4)} | ${pnlColor(`${pnlSign}$${pnlUp.toFixed(2)} (${pnlPercent}%)`)} | ${market.tradesUp} trades`);
            } else {
                console.log(`${upLine} | ${market.tradesUp} trades`);
            }
            
            // DOWN line - compact
            const downLine = `│  ${chalk.red('📉 DOWN')}: ${market.sharesDown.toFixed(2)} shares | $${market.investedDown.toFixed(2)} @ $${avgPriceDown.toFixed(4)}`;
            if (market.currentPriceDown !== undefined) {
                const pnlColor = pnlDown >= 0 ? chalk.green : chalk.red;
                const pnlSign = pnlDown >= 0 ? '+' : '';
                const pnlPercent = market.investedDown > 0 ? ((pnlDown / market.investedDown) * 100).toFixed(1) : '0.0';
                console.log(`${downLine} | Now: $${market.currentPriceDown.toFixed(4)} | ${pnlColor(`${pnlSign}$${pnlDown.toFixed(2)} (${pnlPercent}%)`)} | ${market.tradesDown} trades`);
            } else {
                console.log(`${downLine} | ${market.tradesDown} trades`);
            }
            
            // Summary line - compact
            const totalCurrentValue = currentValueUp + currentValueDown;
            const totalPnlColor = totalPnl >= 0 ? chalk.green : chalk.red;
            const totalPnlSign = totalPnl >= 0 ? '+' : '';
            const totalPnlPercent = totalInvested > 0 ? ((totalPnl / totalInvested) * 100).toFixed(1) : '0.0';
            
            if (totalPnl !== 0 || (market.currentPriceUp !== undefined || market.currentPriceDown !== undefined)) {
                console.log(chalk.cyan(`│  💰 Invested: $${totalInvested.toFixed(2)} | Value: $${totalCurrentValue.toFixed(2)} | ${totalPnlColor(`PnL: ${totalPnlSign}$${totalPnl.toFixed(2)} (${totalPnlPercent}%)`)}`));
            } else {
                console.log(chalk.cyan(`│  💰 Total Invested: $${totalInvested.toFixed(2)}`));
            }
            
            // Visual bar - compact
            const barLength = 30;
            const upBars = Math.round((upPercent / 100) * barLength);
            const downBars = barLength - upBars;
            const upBar = chalk.green('█'.repeat(upBars));
            const downBar = chalk.red('█'.repeat(downBars));
            console.log(chalk.gray(`│  [${upBar}${downBar}] ${upPercent.toFixed(1)}% UP / ${downPercent.toFixed(1)}% DOWN`));
            console.log(chalk.gray('└' + '─'.repeat(78)));
            console.log(''); // Empty line between markets
        }

        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(''); // Empty line at end
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

