import axios from 'axios';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import { AppStateSnapshot, emitStateSnapshot } from './appState';

const MIN_INTERVAL_MS = parseInt(process.env.WEBAPP_PUSH_INTERVAL_MS || '2000', 10);
let lastPushedAt = 0;
let pendingTimer: NodeJS.Timeout | null = null;

const sendPayload = async (reason: string, snapshot: AppStateSnapshot): Promise<void> => {
    const url = ENV.WEBAPP_PUSH_URL;
    if (!url) {
        return;
    }

    lastPushedAt = Date.now();
    pendingTimer = null;

    try {
        const botId = process.env.BOT_ID || 'watcher';
        await axios.post(
            url,
            {
                botId,
                reason,
                runtimeMode: snapshot.mode,
                payload: snapshot,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    ...(ENV.WEBAPP_API_KEY ? { Authorization: `Bearer ${ENV.WEBAPP_API_KEY}` } : {}),
                },
                timeout: ENV.WEBAPP_PUSH_TIMEOUT_MS,
            }
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.warning(`Failed to push update to web app: ${message}`);
    }
};

export const publishAppState = (reason: string): void => {
    const snapshot = emitStateSnapshot(reason);

    if (!ENV.WEBAPP_PUSH_URL) {
        return;
    }

    const now = Date.now();
    const elapsed = now - lastPushedAt;

    if (elapsed >= MIN_INTERVAL_MS) {
        void sendPayload(reason, snapshot);
        return;
    }

    if (pendingTimer) {
        return;
    }

    pendingTimer = setTimeout(() => {
        const debouncedSnapshot = emitStateSnapshot(`${reason}-debounced`);
        void sendPayload(`${reason}-debounced`, debouncedSnapshot);
    }, MIN_INTERVAL_MS - elapsed);
};

export default publishAppState;
