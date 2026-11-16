import { nextRoute } from '@/lib/hosted/next';

export const GET = nextRoute('GET', '/api/v1/conversations/:id/devices');
export const OPTIONS = nextRoute('OPTIONS', '/api/v1/conversations/:id/devices');
