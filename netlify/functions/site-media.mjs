import { handle } from '../../server/api.mjs';
export default (req, context) => handle(req, 'media', { readOnly: context.deploy?.context !== 'production' });
