import type { ResponseAnnotation } from "./responseAnnotations";

export const COMPOSER_SELECTION_EVENT = "threadex:composer-selection";

export function sendSelectionToComposer(annotation: ResponseAnnotation) {
  window.dispatchEvent(new CustomEvent(COMPOSER_SELECTION_EVENT, { detail: annotation }));
}
