// Cloudflare Pages: runs the booking API (/api/*) with the same code as the Worker.
import worker from '../../src/index.js';

export const onRequest = (context) =>
  worker.fetch(context.request, context.env, { waitUntil: (p) => context.waitUntil(p), passThroughOnException: () => {} });
