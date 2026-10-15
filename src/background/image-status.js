// Per-image progress badges are disabled: the page-level progress board shows
// progress, and image-specific errors use IMAGE_ERROR (jobs/result-delivery ->
// content/image-finder). This no-op keeps the seam for re-enabling them
// without changing batch ownership/state contracts.
export function publishImageStatus(_batch, _key, _item) {
  return false;
}
