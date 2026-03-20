import { Hono } from 'hono';

export const meRouter = new Hono();

meRouter.get('/', async (c) => {
  const agentId = c.get('agent_id') as string;
  const customerId = c.get('customer_id') as string;
  const agentName = c.get('agent_name') as string;
  const tier = c.get('customer_tier') as string;

  return c.json({
    agent_id: agentId,
    agent_name: agentName,
    customer_id: customerId,
    customer_tier: tier,
    authenticated: true,
    message: 'Your API key is valid. Use agent_id in log-outcome and get-scores if needed.',
  });
});
