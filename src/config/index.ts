import dotenv from 'dotenv';
import path from 'path';

// Paths resolve from the working directory (the project root for npm scripts
// and Docker) rather than __dirname, which points into dist/ after a build.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

interface Config {
  database: {
    url: string;
  };
  server: {
    port: number;
    nodeEnv: string;
  };
  /** Folder holding ledger_records.csv, bank_transactions.csv and ground_truth.json */
  dataDir: string;
}

const config: Config = {
  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/reconagent',
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR || 'data'),
};

export default config;
