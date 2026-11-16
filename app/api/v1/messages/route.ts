import { nextRoute } from '@/lib/hosted/next';

export const GET = nextRoute('GET', '/api/v1/messages');
export const POST = nextRoute('POST', '/api/v1/messages');
export const OPTIONS = nextRoute('OPTIONS', '/api/v1/messages');
