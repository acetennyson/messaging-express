type UploadResult = {
  success: boolean;
  url?: string;
  fileName?: string;
  error?: string;
};

const UPLOAD_ENDPOINT = process.env.NEXT_MEDIA_UPLOAD_ENDPOINT || 'http://localhost:8000/upload';

export function generateUniqueId(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return (prefix ? `${prefix.replace(/\s+/g, '_')}_` : '') + rand;
}

export async function uploadFile(file: File, uniqueId: string, category = 'default', fileType: 'image' | 'video' | 'file' = 'image', onProgress?: (progress: number) => void): Promise<UploadResult> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('file', file);
    form.append('uniqueId', uniqueId);
    form.append('category', category);
    form.append('fileType', fileType);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', UPLOAD_ENDPOINT, true);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        const percent = Math.round((e.loaded / e.total) * 100);
        onProgress(percent);
      }
    };
    xhr.onload = () => {
      try {
        const res = JSON.parse(xhr.responseText);
        if (res && res.success) {
          resolve({ success: true, url: res.url, fileName: res.fileName || res.originalFileName });
        } else {
          resolve({ success: false, error: res.error || 'Upload failed' });
        }
      } catch (err) {
        resolve({ success: false, error: 'Invalid server response' });
      }
    };
    xhr.onerror = () => resolve({ success: false, error: 'Network error' });
    xhr.send(form);
  });
}

export async function uploadFiles(files: File[], uniqueId: string, category = 'default', fileType: 'image' | 'video' | 'file' = 'image', onProgress?: (fileIndex: number, progress: number) => void) {
  const results: UploadResult[] = [];
  for (let i = 0; i < files.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await uploadFile(files[i], uniqueId, category, fileType, (progress) => onProgress && onProgress(i, progress));
    results.push(res);
  }
  return results;
}

export async function uploadPropertyMedia(mediaData: { category: string; images?: File[]; videos?: File[] }[], uniqueId: string, progressCb?: (category: string, progress: number, message?: string) => void) {
  const images: { category: string; urls: string[] }[] = [];
  const errors: string[] = [];

  for (const item of mediaData) {
    const urls: string[] = [];
    if (item.images && item.images.length) {
      const res = await uploadFiles(item.images, uniqueId, item.category, 'image', (idx, p) => progressCb && progressCb(item.category, p, `Uploading image ${idx + 1}/${item.images?.length || 0}`));
      for (const r of res) {
        if (r.success && r.url) urls.push(r.url);
        else if (r.error) errors.push(r.error);
      }
    }
    images.push({ category: item.category, urls });
  }

  return { success: errors.length === 0, images, errors };
}