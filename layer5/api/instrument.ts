import 'dotenv/config';
import * as Sentry from '@sentry/node';

const envDsn = (process.env.SENTRY_DSN ?? '').trim();
const SENTRY_DSN = envDsn
    || 'https://1ba87dc92c1174a7f6df7d9ffe1a7b3d@o4511049840328704.ingest.us.sentry.io/4511049847275520';

if (SENTRY_DSN) {
    Sentry.init({
        dsn: SENTRY_DSN,
        environment: process.env.NODE_ENV || 'production',
        tracesSampleRate: 1.0,
        sendDefaultPii: true,
    });
}
