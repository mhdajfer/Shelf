import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';

// Integration tests need DATABASE_URL, which lives in the repo-root .env.
loadDotenv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
