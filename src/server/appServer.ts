import cors from 'cors';
import express from 'express';
import path from 'path';
import Logger from '../utils/logger';
import { getSnapshot, subscribeToState, AppStateSnapshot } from '../services/appState';
import watchlistManager from '../services/watchlistManager';

export interface AppServerHandle {
    port: number;
    stop: () => Promise<void>;
}

export const startAppServer = async (): Promise<AppServerHandle> => {
    const app = express();
    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(process.cwd(), 'public')));

    app.get('/', (_req, res) => {
        res.json({
            message: 'EdgeBot API is running',
            endpoints: [
                '/health',
                '/state',
                '/events',
                '/dashboard',
                '/watchlist',
                '/watchlist/add',
                '/watchlist/remove',
                '/watchlist/toggle',
                '/watchlist/alias',
            ],
        });
    });

    app.get('/health', (_req, res) => {
        const snapshot = getSnapshot();
        res.json({
            ok: snapshot.running,
            status: snapshot.status,
            updatedAt: snapshot.updatedAt,
        });
    });

    app.get('/state', (_req, res) => {
        res.json(getSnapshot());
    });

    app.get('/dashboard', (_req, res) => {
        res.sendFile(path.join(process.cwd(), 'public', 'dashboard.html'));
    });

    // Watchlist API endpoints - allows webapp to manage tracked addresses as "bots"
    // Handler functions for reuse across both /watchlist/* and /api/watchlist/* paths
    const handleGetWatchlist = (_req: express.Request, res: express.Response) => {
        const addresses = watchlistManager.getAllAddresses();
        const counts = watchlistManager.getCount();
        res.json({
            success: true,
            data: {
                addresses,
                count: counts.total,
                lastModified: Date.now(),
            },
        });
    };

    const handleAddAddress = (req: express.Request, res: express.Response) => {
        const { address, alias } = req.body;

        if (!address) {
            res.status(400).json({ success: false, error: 'Address is required' });
            return;
        }

        const result = watchlistManager.addAddress(address, alias);
        if (result) {
            res.json({
                success: true,
                message: `Added address ${alias || address}`,
                data: watchlistManager.toJSON(),
            });
        } else {
            res.status(400).json({
                success: false,
                error: 'Failed to add address (invalid format or already exists)',
            });
        }
    };

    const handleRemoveAddress = (req: express.Request, res: express.Response) => {
        const { address } = req.body;

        if (!address) {
            res.status(400).json({ success: false, error: 'Address is required' });
            return;
        }

        const result = watchlistManager.removeAddress(address);
        if (result) {
            res.json({
                success: true,
                message: `Removed address ${address}`,
                data: watchlistManager.toJSON(),
            });
        } else {
            res.status(404).json({ success: false, error: 'Address not found in watchlist' });
        }
    };

    const handleToggleAddress = (req: express.Request, res: express.Response) => {
        const { address, enabled } = req.body;

        if (!address) {
            res.status(400).json({ success: false, error: 'Address is required' });
            return;
        }

        const result = watchlistManager.toggleAddress(address, enabled);
        if (result) {
            const entry = watchlistManager.getAddress(address);
            res.json({
                success: true,
                message: `Address ${address} is now ${entry?.enabled ? 'enabled' : 'disabled'}`,
                data: watchlistManager.toJSON(),
            });
        } else {
            res.status(404).json({ success: false, error: 'Address not found in watchlist' });
        }
    };

    const handleSetAlias = (req: express.Request, res: express.Response) => {
        const { address, alias } = req.body;

        if (!address || !alias) {
            res.status(400).json({ success: false, error: 'Address and alias are required' });
            return;
        }

        const result = watchlistManager.setAlias(address, alias);
        if (result) {
            res.json({
                success: true,
                message: `Set alias for ${address}: ${alias}`,
                data: watchlistManager.toJSON(),
            });
        } else {
            res.status(404).json({ success: false, error: 'Address not found in watchlist' });
        }
    };

    // Register routes for both /watchlist/* and /api/watchlist/* paths
    app.get('/watchlist', handleGetWatchlist);
    app.get('/api/watchlist', handleGetWatchlist);

    app.post('/watchlist/add', handleAddAddress);
    app.post('/api/watchlist/add', handleAddAddress);

    app.post('/watchlist/remove', handleRemoveAddress);
    app.post('/api/watchlist/remove', handleRemoveAddress);

    app.post('/watchlist/toggle', handleToggleAddress);
    app.post('/api/watchlist/toggle', handleToggleAddress);

    app.post('/watchlist/alias', handleSetAlias);
    app.post('/api/watchlist/alias', handleSetAlias);

    app.get('/events', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const sendSnapshot = (snapshot: AppStateSnapshot, reason: string) => {
            res.write(`event: ${reason}\n`);
            res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        };

        // Send initial state
        sendSnapshot(getSnapshot(), 'init');

        const unsubscribe = subscribeToState((snapshot, reason) => {
            sendSnapshot(snapshot, reason);
        });

        req.on('close', () => {
            unsubscribe();
            res.end();
        });
    });

    const defaultPort = parseInt(process.env.PORT || '3001', 10);
    const maxRetries = 10;

    const tryListen = (port: number, attempt: number): Promise<AppServerHandle> => {
        return new Promise((resolve, reject) => {
            const server = app.listen(port);

            server.on('listening', () => {
                Logger.success(`Web API listening on port ${port}`);
                resolve({
                    port,
                    stop: () =>
                        new Promise<void>((resolveClose, rejectClose) => {
                            server.close((error) => {
                                if (error) {
                                    rejectClose(error);
                                } else {
                                    resolveClose();
                                }
                            });
                        }),
                });
            });

            server.on('error', (error: NodeJS.ErrnoException) => {
                if (error.code === 'EADDRINUSE') {
                    server.close();
                    if (attempt < maxRetries) {
                        const nextPort = port + 1;
                        Logger.warning(`Port ${port} in use, trying ${nextPort}...`);
                        resolve(tryListen(nextPort, attempt + 1));
                    } else {
                        reject(new Error(`Could not find available port after ${maxRetries} attempts`));
                    }
                } else {
                    reject(error);
                }
            });
        });
    };

    return tryListen(defaultPort, 1);
};

export default startAppServer;
