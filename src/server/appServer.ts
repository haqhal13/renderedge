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
    app.get('/watchlist', (_req, res) => {
        const addresses = watchlistManager.getAllAddresses();
        const counts = watchlistManager.getCount();
        res.json({
            ok: true,
            total: counts.total,
            active: counts.active,
            addresses,
        });
    });

    app.post('/watchlist/add', (req, res) => {
        const { address, alias } = req.body;

        if (!address) {
            res.status(400).json({ ok: false, error: 'Address is required' });
            return;
        }

        const success = watchlistManager.addAddress(address, alias);
        if (success) {
            res.json({
                ok: true,
                message: `Added address ${alias || address}`,
                watchlist: watchlistManager.getAllAddresses(),
            });
        } else {
            res.status(400).json({
                ok: false,
                error: 'Failed to add address (invalid format or already exists)',
            });
        }
    });

    app.post('/watchlist/remove', (req, res) => {
        const { address } = req.body;

        if (!address) {
            res.status(400).json({ ok: false, error: 'Address is required' });
            return;
        }

        const success = watchlistManager.removeAddress(address);
        if (success) {
            res.json({
                ok: true,
                message: `Removed address ${address}`,
                watchlist: watchlistManager.getAllAddresses(),
            });
        } else {
            res.status(404).json({ ok: false, error: 'Address not found in watchlist' });
        }
    });

    app.post('/watchlist/toggle', (req, res) => {
        const { address, enabled } = req.body;

        if (!address) {
            res.status(400).json({ ok: false, error: 'Address is required' });
            return;
        }

        const success = watchlistManager.toggleAddress(address, enabled);
        if (success) {
            const entry = watchlistManager.getAddress(address);
            res.json({
                ok: true,
                message: `Address ${address} is now ${entry?.enabled ? 'enabled' : 'disabled'}`,
                watchlist: watchlistManager.getAllAddresses(),
            });
        } else {
            res.status(404).json({ ok: false, error: 'Address not found in watchlist' });
        }
    });

    app.post('/watchlist/alias', (req, res) => {
        const { address, alias } = req.body;

        if (!address || !alias) {
            res.status(400).json({ ok: false, error: 'Address and alias are required' });
            return;
        }

        const success = watchlistManager.setAlias(address, alias);
        if (success) {
            res.json({
                ok: true,
                message: `Set alias for ${address}: ${alias}`,
                watchlist: watchlistManager.getAllAddresses(),
            });
        } else {
            res.status(404).json({ ok: false, error: 'Address not found in watchlist' });
        }
    });

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

    const port = 3001;

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
            reject(error);
        });
    });
};

export default startAppServer;
