const https = require('https');
require('dotenv').config({ path: 'api/.env' });

const SUPABASE_URL = process.env.SUPABASE_URL; // https://fakomwsewdxazaqawjuv.supabase.co
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const functions = [
  'scoring-engine',
  'trend-detector',
  'cold-start-bootstrap',
  'trust-updater',
  'pruning-scheduler',
];

async function checkFunction(name) {
  return new Promise((resolve) => {
    const url = new URL(`/functions/v1/${name}`, SUPABASE_URL);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        resolve({ name, status: res.statusCode, body: data.substring(0, 200) });
      });
    });
    req.on('error', (e) => {
      resolve({ name, status: 'ERROR', body: e.message });
    });
    req.write(JSON.stringify({}));
    req.end();
  });
}

(async () => {
  console.log('=== EDGE FUNCTION DEPLOYMENT CHECK ===');
  console.log(`Supabase URL: ${SUPABASE_URL}\n`);
  
  for (const fn of functions) {
    const result = await checkFunction(fn);
    const deployed = result.status !== 404;
    console.log(`  ${fn}: HTTP ${result.status} ${deployed ? '✅ DEPLOYED' : '❌ NOT DEPLOYED'}`);
    if (!deployed || result.status >= 500) {
      console.log(`    Response: ${result.body}`);
    }
  }
})();
