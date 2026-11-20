/**
 * @messaging-express/server: the framework-neutral server core.
 *
 * Everything the server needs is passed in through a ServerContext (config, logger, database, storage, realtime,
 * caches); nothing here reads process.env or imports Next.js. `MessagingServer` is the embedding API on top of them.
 */
export { MessagingServer } from './server';
export type { CloseOptions, AttachRealtimeOptions } from './server';
export type { Audience, ModuleEvent } from './realtime/audience';
export type { AudiencePage } from './realtime/authorize';
export type { NodeHandler, NodeHandlerOptions } from './adapters/node';
export type { InitOptions, MigrateOptions } from './options';
export type { MigrationResult } from './migrations/runner';
export type { AuthIdentity, CustomAuthenticate } from './auth/single-tenant';
export type { AuthContext, AuthStrategy } from './auth/strategy';
export { ConfigError, SchemaNotReadyError, SchemaTooNewError, SchemaChecksumError } from './errors';
export type { ServerContext } from './core/context';
export { createConfig } from './core/config';
export type { ServerConfig, ConfigReader } from './core/config';
export { createDb } from './core/db';
export type { Db } from './core/db';
export { createInflightTracker, detachedDefer } from './core/inflight';
export { routes } from './core/routes';
export { matchRoute, matchPattern, dispatch } from './core/routing';
export type { RouteDef, RouteHandler, RouteParams, HttpMethod } from './core/routing';
export { createLogger } from './logger';
export type { Logger, LogLevel } from './logger';
