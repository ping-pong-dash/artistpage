import { handle } from '../../server/api.mjs';
export default (req, context) => handle(req, 'content', { readOnly: context.deploy?.context !== 'production' });
