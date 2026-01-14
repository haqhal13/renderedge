import cors from 'cors';
import express from 'express';
import path from 'path';
import Logger from '../utils/logger';
import { getSnapshot, subscribeToState, AppStateSnapshot } from '../services/appState';

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
            endpoints: ['/health', '/state', '/events', '/dashboard'],
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

    const port = parseInt(process.env.PORT || '3000', 10);

    return await new Promise<AppServerHandle>((resolve) => {
        const server = app.listen(port, () => {
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
    });
};

export default startAppServer;
