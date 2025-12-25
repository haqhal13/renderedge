import mongoose from 'mongoose';
import { ENV } from './env';
import chalk from 'chalk';

const uri = ENV.MONGO_URI || 'mongodb://localhost:27017/polymarket_copytrading';

const connectDB = async () => {
    // In track-only mode or paper mode without MONGO_URI, skip MongoDB connection
    if ((ENV.TRACK_ONLY_MODE || ENV.PAPER_MODE) && !ENV.MONGO_URI) {
        console.log(chalk.yellow('⚠'), 'MongoDB not configured - running in memory-only mode');
        console.log(chalk.yellow('   Trades will be logged to console and files only'));
        return;
    }

    try {
        await mongoose.connect(uri);
        console.log(chalk.green('✓'), 'MongoDB connected');
    } catch (error) {
        if (ENV.TRACK_ONLY_MODE || ENV.PAPER_MODE) {
            console.log(chalk.yellow('⚠'), 'MongoDB connection failed, continuing in memory-only mode:', error instanceof Error ? error.message : String(error));
        } else {
            console.log(chalk.red('✗'), 'MongoDB connection failed:', error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    }
};

/**
 * Close MongoDB connection gracefully
 */
export const closeDB = async (): Promise<void> => {
    try {
        await mongoose.connection.close();
        console.log(chalk.green('✓'), 'MongoDB connection closed');
    } catch (error) {
        console.log(chalk.red('✗'), 'Error closing MongoDB connection:', error);
    }
};

export default connectDB;
