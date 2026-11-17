import { handle } from '../../server/api.mjs';
export default req => handle(req, 'session');
export const config = { rateLimit: { action: 'rate_limit', aggregateBy: ['ip', 'domain'], windowSize: 60, windowLimit: 20 } };
