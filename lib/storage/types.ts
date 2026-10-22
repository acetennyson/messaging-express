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
}

export interface StoragePresignResult {
  uploadUrl: string;
  publicUrl: string;
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
