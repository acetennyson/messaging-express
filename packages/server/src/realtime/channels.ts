/** Channel (Socket.IO room) names. Kept in a tiny module so route code can use them without importing the socket server. */
export const conversationChannel = (conversationId: string): string => `conversation:${conversationId}`;
/** Every socket whose verified token carries this userId auto-joins this room (E2EE Stage 7.6). */
export const userChannel = (userId: string): string => `user:${userId}`;
