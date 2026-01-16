/**
 * BETABOT Web Dashboard Server
 * Serves static files and broadcasts real-time dashboard updates via WebSocket
 * Also provides REST API for watchlist management
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { dashboardDataCollector } from './dashboardData';
import { ClientMessage } from './types';

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export class AppServer {
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private updateInterval: NodeJS.Timeout | null = null;
  private balanceInterval: NodeJS.Timeout | null = null;
  private port: number;
  private publicDir: string;

  constructor(port: number = 3000) {
    this.port = port;
    this.publicDir = path.join(__dirname, '..', 'public');

    // Create HTTP server for static files
    this.httpServer = createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    // Create WebSocket server attached to HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.setupWebSocket();
  }

  /**
   * Start the server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tryListen = (port: number) => {
        this.port = port;

        const onError = (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && port !== 0) {
            console.warn(
              `[APP] Port ${port} is in use, selecting a free port...`
            );
            this.httpServer.off('error', onError);
            // Ask OS to assign a free port
            tryListen(0);
          } else {
            this.httpServer.off('error', onError);
            console.error(
              '[APP] Failed to start dashboard server:',
              err.message
            );
            reject(err);
          }
        };

        const doListen = () => {
          this.httpServer.once('error', onError);
          try {
            this.httpServer.listen(this.port, () => {
              this.httpServer.off('error', onError);
              const address = this.httpServer.address();
              if (address && typeof address === 'object') {
                this.port = address.port;
              }
              console.log(
                `[APP] Dashboard available at http://localhost:${this.port}`
              );

              // Start broadcasting updates every 1.5 seconds
              this.startBroadcasting();
              resolve();
            });
          } catch (err) {
            this.httpServer.off('error', onError);
            const error = err as NodeJS.ErrnoException;
            if (error.code === 'EADDRINUSE' && port !== 0) {
              console.warn(
                `[APP] Port ${port} is in use (sync), selecting a free port...`
              );
              tryListen(0);
            } else {
              console.error(
                '[APP] Failed to start dashboard server (sync):',
                error.message
              );
              reject(error);
            }
          }
        };

        doListen();
      };

      tryListen(this.port);
    });
  }

  /**
   * Get the actual port the server is listening on
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Stop the server
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    if (this.balanceInterval) {
      clearInterval(this.balanceInterval);
      this.balanceInterval = null;
    }

    // Close all client connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    this.wss.close();
    this.httpServer.close();
    console.log('[APP] Dashboard server stopped');
  }

  /**
   * Get the data collector for external configuration
   */
  getDataCollector() {
    return dashboardDataCollector;
  }

  /**
   * Handle HTTP requests for static files and API endpoints
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // Enable CORS for API endpoints
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API Routes for watchlist management
    // Support both /api/watchlist/* and /watchlist/* paths
    if (url.startsWith('/api/') || url.startsWith('/watchlist')) {
      this.handleApiRequest(req, res, url, method);
      return;
    }

    // Static file serving
    let filePath = url;

    // Default to index.html
    if (filePath === '/') {
      filePath = '/index.html';
    }

    // Security: prevent directory traversal
    const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(this.publicDir, safePath);

    // Ensure path is within public directory
    if (!fullPath.startsWith(this.publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Get file extension and MIME type
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Read and serve the file
    fs.readFile(fullPath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('Not Found');
        } else {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
        return;
      }

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  /**
   * Handle API requests for watchlist management and reset
   * Supports both /api/watchlist/* and /watchlist/* paths
   */
  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    method: string
  ): Promise<void> {
    // Handle reset endpoint
    if (url === '/api/reset' && method === 'POST') {
      await this.handleResetRequest(req, res);
      return;
    }

    // Lazy import watchlist manager to avoid circular dependencies
    const watchlistManager = (await import('../../src/services/watchlistManager')).default;

    try {
      // GET /watchlist or /api/watchlist - Get all watched addresses
      if ((url === '/api/watchlist' || url === '/watchlist') && method === 'GET') {
        const data = watchlistManager.toJSON();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: {
            addresses: data.addresses,
            count: data.addresses.length,
            lastModified: data.lastModified,
          },
        }));
        return;
      }

      // POST /watchlist/add or /api/watchlist/add - Add a new address
      if ((url === '/api/watchlist/add' || url === '/watchlist/add') && method === 'POST') {
        const body = await this.parseBody(req);
        const { address, alias } = body;

        if (!address) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Address is required' }));
          return;
        }

        const success = watchlistManager.addAddress(address, alias);
        if (success) {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Address added', data: watchlistManager.toJSON() }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Failed to add address (invalid or duplicate)' }));
        }
        return;
      }

      // POST /watchlist/remove or /api/watchlist/remove - Remove an address
      if ((url === '/api/watchlist/remove' || url === '/watchlist/remove') && method === 'POST') {
        const body = await this.parseBody(req);
        const { address } = body;

        if (!address) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Address is required' }));
          return;
        }

        const success = watchlistManager.removeAddress(address);
        if (success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Address removed', data: watchlistManager.toJSON() }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Address not found' }));
        }
        return;
      }

      // POST /watchlist/toggle or /api/watchlist/toggle - Toggle address enabled/disabled
      if ((url === '/api/watchlist/toggle' || url === '/watchlist/toggle') && method === 'POST') {
        const body = await this.parseBody(req);
        const { address, enabled } = body;

        if (!address) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Address is required' }));
          return;
        }

        const success = watchlistManager.toggleAddress(address, enabled);
        if (success) {
          const entry = watchlistManager.getAddress(address);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `Address ${entry?.enabled ? 'enabled' : 'disabled'}`,
            data: watchlistManager.toJSON()
          }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Address not found' }));
        }
        return;
      }

      // POST /watchlist/alias or /api/watchlist/alias - Set alias for address
      if ((url === '/api/watchlist/alias' || url === '/watchlist/alias') && method === 'POST') {
        const body = await this.parseBody(req);
        const { address, alias } = body;

        if (!address || !alias) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Address and alias are required' }));
          return;
        }

        const success = watchlistManager.setAlias(address, alias);
        if (success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Alias set', data: watchlistManager.toJSON() }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Address not found' }));
        }
        return;
      }

      // POST /api/watchlist - Add a new address (legacy endpoint)
      if (url === '/api/watchlist' && method === 'POST') {
        const body = await this.parseBody(req);
        const { address, alias } = body;

        if (!address) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Address is required' }));
          return;
        }

        const success = watchlistManager.addAddress(address, alias);
        if (success) {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Address added' }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to add address (invalid or duplicate)' }));
        }
        return;
      }

      // DELETE /api/watchlist/:address - Remove an address (legacy endpoint)
      if (url.startsWith('/api/watchlist/') && method === 'DELETE') {
        const address = decodeURIComponent(url.replace('/api/watchlist/', ''));
        const success = watchlistManager.removeAddress(address);

        if (success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Address removed' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Address not found' }));
        }
        return;
      }

      // POST /api/watchlist/:address/toggle - Toggle address enabled/disabled (legacy endpoint)
      if (url.match(/^\/api\/watchlist\/[^/]+\/toggle$/) && method === 'POST') {
        const address = decodeURIComponent(url.replace('/api/watchlist/', '').replace('/toggle', ''));
        const body = await this.parseBody(req);
        const enabled = body.enabled;

        const success = watchlistManager.toggleAddress(address, enabled);
        if (success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Address toggled' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Address not found' }));
        }
        return;
      }

      // POST /api/watchlist/:address/alias - Set alias for address (legacy endpoint)
      if (url.match(/^\/api\/watchlist\/[^/]+\/alias$/) && method === 'POST') {
        const address = decodeURIComponent(url.replace('/api/watchlist/', '').replace('/alias', ''));
        const body = await this.parseBody(req);
        const { alias } = body;

        if (!alias) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Alias is required' }));
          return;
        }

        const success = watchlistManager.setAlias(address, alias);
        if (success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Alias set' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Address not found' }));
        }
        return;
      }

      // POST /api/watchlist/reload - Force reload from file
      if (url === '/api/watchlist/reload' && method === 'POST') {
        watchlistManager.forceReload();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Watchlist reloaded' }));
        return;
      }

      // 404 for unknown API routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API endpoint not found' }));
    } catch (error) {
      console.error('[APP] API error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Parse JSON body from request
   */
  private parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Set up WebSocket server event handlers
   */
  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      console.log(`[APP] Client connected (${this.clients.size} total)`);

      // Send immediate update on connection
      this.sendUpdate(ws);

      // Handle client disconnect
      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[APP] Client disconnected (${this.clients.size} remaining)`);
      });

      // Handle client messages
      ws.on('message', (data: Buffer) => {
        try {
          const msg: ClientMessage = JSON.parse(data.toString());
          this.handleClientMessage(ws, msg);
        } catch (e) {
          // Ignore invalid JSON
        }
      });

      // Handle errors
      ws.on('error', (err) => {
        console.error('[APP] WebSocket error:', err.message);
        this.clients.delete(ws);
      });
    });
  }

  /**
   * Handle incoming client messages
   */
  private handleClientMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'refresh':
        this.sendUpdate(ws);
        break;
      case 'ping':
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
        break;
    }
  }

  /**
   * Start the broadcast loop
   */
  private startBroadcasting(): void {
    this.updateInterval = setInterval(() => {
      this.broadcast();
    }, 1500); // 1.5 second refresh

    // Periodically refresh on-chain wallet balance for the dashboard
    const refresh = async () => {
      try {
        await dashboardDataCollector.refreshWalletBalance();
      } catch {
        // Ignore balance refresh errors to keep dashboard stable
      }
    };

    // Initial fetch and then every 60 seconds
    refresh();
    this.balanceInterval = setInterval(refresh, 60000);
  }

  /**
   * Broadcast dashboard update to all connected clients
   */
  private broadcast(): void {
    if (this.clients.size === 0) return;

    try {
      const update = dashboardDataCollector.getDashboardUpdate();
      const message = JSON.stringify(update);

      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    } catch (err) {
      console.error('[APP] Error broadcasting update:', err);
    }
  }

  /**
   * Send update to a specific client
   */
  private sendUpdate(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      const update = dashboardDataCollector.getDashboardUpdate();
      ws.send(JSON.stringify(update));
    } catch (err) {
      console.error('[APP] Error sending update:', err);
    }
  }

  /**
   * Handle reset request from external webapp
   */
  private async handleResetRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const target = data.target || 'gabagool';

        console.log(`[APP] Reset requested: ${target}`);

        // Import and reset the watcherPnLTracker
        try {
          const watcherPnLTracker = (await import('../../src/services/watcherPnLTracker')).default;
          watcherPnLTracker.resetAll();
          console.log('[APP] WatcherPnLTracker reset complete');
        } catch (err) {
          console.error('[APP] Error resetting watcherPnLTracker:', err);
        }

        // Reset dashboard data collector
        try {
          dashboardDataCollector.reset();
          console.log('[APP] DashboardDataCollector reset complete');
        } catch (err) {
          console.error('[APP] Error resetting dashboardDataCollector:', err);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Reset triggered for Gabagool22` }));
      } catch (e) {
        console.error('[APP] Error handling reset:', e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON or reset failed' }));
      }
    });

    req.on('error', (err) => {
      console.error('[APP] Error reading reset request:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request error' }));
    });
  }
}

// Export for use in main bot
export { dashboardDataCollector } from './dashboardData';
