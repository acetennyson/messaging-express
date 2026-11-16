import { nextRoute } from '@/lib/hosted/next';

export const POST = nextRoute('POST', '/api/v1/users/:userId/devices/reset');
export const OPTIONS = nextRoute('OPTIONS', '/api/v1/users/:userId/devices/reset');
