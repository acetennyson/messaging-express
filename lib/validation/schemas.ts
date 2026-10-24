import { z } from 'zod';

// Organization schemas
export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  plan: z.enum(['free', 'pro', 'enterprise']).default('free'),
  webhookUrl: z.string().url().optional(),
});

export const updateOrganizationSchema = createOrganizationSchema.partial();

// Project schemas
export const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  allowedOrigins: z.array(z.string().url()).optional(),
  settings: z.record(z.any()).optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

// User schemas
export const createUserSchema = z.object({
  externalId: z.string().min(1).max(255).optional(),
  name: z.string().min(1).max(255),
  email: z.string().email().optional(),
  avatarUrl: z.string().url().optional(),
  metadata: z.record(z.any()).optional(),
});

export const updateUserSchema = createUserSchema.partial();

// Conversation schemas
export const createConversationSchema = z.object({
  type: z.enum(['direct', 'group', 'support']),
  title: z.string().max(255).optional(),
  participantIds: z.array(z.string().uuid()).min(1),
  metadata: z.record(z.any()).optional(),
});

export const updateConversationSchema = z.object({
  title: z.string().max(255).optional(),
  isArchived: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
});

// Message schemas
export const createMessageSchema = z.object({
  conversationId: z.string().uuid(),
  senderId: z.string().uuid(),
  content: z.string().optional(),
  type: z.enum(['text', 'image', 'video', 'file', 'system']).default('text'),
  parentId: z.string().uuid().optional(),
  metadata: z.record(z.any()).optional(),
  attachments: z.array(z.object({
    type: z.enum(['image', 'video', 'file']),
    url: z.string().url(),
    thumbnailUrl: z.string().url().optional(),
    filename: z.string().max(255).optional(),
    mimeType: z.string().max(100).optional(),
    sizeBytes: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationSeconds: z.number().positive().optional(),
    metadata: z.record(z.any()).optional(),
  })).optional(),
});

export const updateMessageSchema = z.object({
  content: z.string().optional(),
  isDeleted: z.boolean().optional(),
});

// Reaction schema
export const addReactionSchema = z.object({
  messageId: z.string().uuid(),
  emoji: z.string().max(20),
});

// Typing indicator schema
export const typingIndicatorSchema = z.object({
  conversationId: z.string().uuid(),
  userId: z.string().uuid(),
  isTyping: z.boolean(),
});

// Pagination schema
export const paginationSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  cursor: z.string().optional(),
  sort: z.string().optional(),
});

// Message query schema
export const messageQuerySchema = paginationSchema.extend({
  conversationId: z.string().uuid(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  type: z.enum(['text', 'image', 'video', 'file', 'system']).optional(),
  senderId: z.string().uuid().optional(),
});

// User query schema
export const userQuerySchema = paginationSchema.extend({
  search: z.string().max(255).optional(),
  externalId: z.string().max(255).optional(),
});

// Conversation query schema
export const conversationQuerySchema = paginationSchema.extend({
  type: z.enum(['direct', 'group', 'support']).optional(),
  isArchived: z.boolean().optional(),
  userId: z.string().uuid().optional(),
});

export type CreateOrganization = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;
export type CreateProject = z.infer<typeof createProjectSchema>;
export type UpdateProject = z.infer<typeof updateProjectSchema>;
export type CreateUser = z.infer<typeof createUserSchema>;
export type UpdateUser = z.infer<typeof updateUserSchema>;
export type CreateConversation = z.infer<typeof createConversationSchema>;
export type UpdateConversation = z.infer<typeof updateConversationSchema>;
export type CreateMessage = z.infer<typeof createMessageSchema>;
export type UpdateMessage = z.infer<typeof updateMessageSchema>;
export type AddReaction = z.infer<typeof addReactionSchema>;
export type TypingIndicator = z.infer<typeof typingIndicatorSchema>;
export type MessageQuery = z.infer<typeof messageQuerySchema>;
export type ConversationQuery = z.infer<typeof conversationQuerySchema>;
