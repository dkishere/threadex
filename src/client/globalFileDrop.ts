type FileDropHandler = (files: FileList) => void | Promise<void>;

export const COMPACT_FILE_DROP_QUERY = "(width < 1080px)";

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function isComposerDropTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-file-drop-target="true"]'));
}

/**
 * Makes every part of the page a file drop target while letting the composer
 * retain ownership when a file lands directly on it.
 */
export function installGlobalFileDrop(onFiles: FileDropHandler) {
  let dragDepth = 0;
  const compact = window.matchMedia(COMPACT_FILE_DROP_QUERY);

  function blockCompactDrop(event: DragEvent) {
    if (!compact.matches) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    clearDragState();
    return true;
  }

  function clearDragState() {
    dragDepth = 0;
    document.body.removeAttribute("data-file-drag-active");
  }

  function handleDragEnter(event: DragEvent) {
    if (!hasFiles(event)) return;
    if (blockCompactDrop(event)) return;
    event.preventDefault();
    dragDepth += 1;
    document.body.setAttribute("data-file-drag-active", "true");
  }

  function handleDragOver(event: DragEvent) {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !hasFiles(event)) return;
    if (blockCompactDrop(event)) return;
    event.preventDefault();
    dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent) {
    if (!document.body.hasAttribute("data-file-drag-active")) return;
    if (hasFiles(event)) dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) clearDragState();
  }

  function handleDrop(event: DragEvent) {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !hasFiles(event)) return;
    if (blockCompactDrop(event)) return;
    event.preventDefault();
    clearDragState();
    if (isComposerDropTarget(event.target)) return;
    event.stopPropagation();
    if (dataTransfer.files.length > 0) {
      void onFiles(dataTransfer.files);
    }
  }

  compact.addEventListener("change", clearDragState);
  window.addEventListener("dragenter", handleDragEnter, true);
  window.addEventListener("dragover", handleDragOver, true);
  window.addEventListener("dragleave", handleDragLeave, true);
  window.addEventListener("drop", handleDrop, true);
  return () => {
    clearDragState();
    compact.removeEventListener("change", clearDragState);
    window.removeEventListener("dragenter", handleDragEnter, true);
    window.removeEventListener("dragover", handleDragOver, true);
    window.removeEventListener("dragleave", handleDragLeave, true);
    window.removeEventListener("drop", handleDrop, true);
  };
}
