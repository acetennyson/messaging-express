export interface StorageUploadInput {
  projectId: string;
  file: Buffer;
  filename: string;
  mimeType: string;
  category?: string;
}

export interface StorageUploadResult {
  url: string;
  thumbnailUrl?: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface StoragePresignInput {
  projectId: string;
  filename: string;
  mimeType: string;
  /** When given, providers that can should bind the signed URL to this exact size. */
  sizeBytes?: number;
  category?: string;
}

export interface StoragePresignResult {
  uploadUrl: string;
  publicUrl: string;
  /** HTTP method the client must use against uploadUrl. Defaults to PUT. */
  method?: 'PUT' | 'POST';
  /** Headers the client MUST send with the upload (they are part of the signature). */
  headers?: Record<string, string>;
  fields?: Record<string, string>;
}

export interface StorageProvider {
  /** 's3' | 'supabase' | 'firebase' | 'php' | 'local' */
  name: string;
  upload(input: StorageUploadInput): Promise<StorageUploadResult>;
  delete(url: string): Promise<void>;
  /**
   * Optional: providers that support it return a client-uploadable URL
   * instead of proxying bytes through our server.
   */
  getPresignedUploadUrl?(input: StoragePresignInput): Promise<StoragePresignResult>;
}
