import { nextRoute } from '@/lib/hosted/next';

export const POST = nextRoute('POST', '/api/internal/webhooks/retry');
export const GET = nextRoute('GET', '/api/internal/webhooks/retry');
