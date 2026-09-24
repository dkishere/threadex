export type ArchivePreview = {
  format: "zip";
  entries: Array<{ path: string; directory: boolean; size: number; compressedSize: number }>;
};
