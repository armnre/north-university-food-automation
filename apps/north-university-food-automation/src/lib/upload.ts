import { useState } from 'react';
import { uploadFoodImage } from './api';

/** Drop-in for zitejs/upload: uploads to the API's validated food-image endpoint. */
export function useUpload() {
  const [isUploading, setUploading] = useState(false);
  const upload = async (file: File) => {
    setUploading(true);
    try { return await uploadFoodImage(file); } finally { setUploading(false); }
  };
  return { upload, isUploading };
}
