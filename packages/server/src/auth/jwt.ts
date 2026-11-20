import jwt from 'jsonwebtoken';
import type { ServerContext } from '../core/context';

// The secret and expiry come from ctx.config.jwt (fixed when the context is created; a missing secret throws there).

export interface JWTPayload {
  projectId: string;
  userId?: string;
  organizationId?: string;
  type: 'api' | 'user' | 'admin';
  iat?: number;
  exp?: number;
}

export function signToken(ctx: ServerContext, payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, ctx.config.jwt.secret, {
    expiresIn: ctx.config.jwt.expiration as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(ctx: ServerContext, token: string): JWTPayload {
  try {
    return jwt.verify(token, ctx.config.jwt.secret) as JWTPayload;
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
}

export function decodeToken(token: string): JWTPayload | null {
  try {
    return jwt.decode(token) as JWTPayload;
  } catch {
    return null;
  }
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}
