import { query } from '@/lib/db/pool';

export async function GET() {
  try {
    const startTime = Date.now();
    await query('SELECT 1');
    const duration = Date.now() - startTime;

    if (duration > 2000) {
      return new Response(
        JSON.stringify({
          status: 'degraded',
          database: 'slow',
          duration,
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({
        status: 'ok',
        database: 'healthy',
        duration,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        status: 'error',
        database: 'unhealthy',
        error: 'Database connection failed',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
