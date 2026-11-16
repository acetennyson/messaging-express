import { nextRoute } from '@/lib/hosted/next';

export const POST = nextRoute('POST', '/api/v1/conversations/:id/keys/request');
export const OPTIONS = nextRoute('OPTIONS', '/api/v1/conversations/:id/keys/request');
