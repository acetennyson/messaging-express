import { nextRoute } from '@/lib/hosted/next';

export const GET = nextRoute('GET', '/api/v1/conversations');
export const POST = nextRoute('POST', '/api/v1/conversations');
export const OPTIONS = nextRoute('OPTIONS', '/api/v1/conversations');
