const fs = require('fs');
let f = fs.readFileSync('routes/log-outcome.ts', 'utf8');
f = f.replace(/\\\`/g, '`');
f = f.replace(/\\\$/g, '$');
fs.writeFileSync('routes/log-outcome.ts', f);
console.log('Fixed log-outcome.ts template literals.');
