import { nextRoute } from '@/lib/hosted/next';

export const GET = nextRoute('GET', '/api/v1/devices');
export const POST = nextRoute('POST', '/api/v1/devices');
export const OPTIONS = nextRoute('OPTIONS', '/api/v1/devices');
