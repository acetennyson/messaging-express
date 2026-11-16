import { nextRoute } from '@/lib/hosted/next';

export const GET = nextRoute('GET', '/uploads/*path');
export const OPTIONS = nextRoute('OPTIONS', '/uploads/*path');
