import { Hono } from 'hono';

const app = new Hono();
app.post('/v1/log-outcome', async (c) => {
    console.log("HIT ROUTE! Body =>", await c.req.json());
    console.log("Authorization Header =>", c.req.header('Authorization'));
    return c.json({ ok: 1 });
});

export const localMemoryQueue: any[] = [];
export function startMemoryQueueWorker(app: any): void {
    setInterval(async () => {
        if (localMemoryQueue.length === 0) return;
        const batch = localMemoryQueue.splice(0, 50);
        for (const item of batch) {
            try {
                // Must use http://localhost or similar relative path according to Hono's implementation?
                const res = await app.request('/v1/log-outcome', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-li-outcome-worker': '1',
                        'Authorization': item.api_key ?? '',
                    },
                    body: JSON.stringify(item.body)
                });
                console.log("RESPONSE FROM LOOPBACK: ", res.status, await res.text());
            } catch (err: unknown) {
                console.error('Loopback Catch Error:', err);
            }
        }
    }, 1500);
}

startMemoryQueueWorker(app);
localMemoryQueue.push({ body: { hello: "world" }, api_key: "Bearer layerinfinite_test_key" });

setTimeout(() => process.exit(0), 3000);
