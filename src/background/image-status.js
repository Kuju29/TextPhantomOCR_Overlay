// Per-image progress presentation is intentionally disabled.
//
// The user already has a page-level progress indicator. Updating a badge on
// every image throughout Lens/AI/repair added DOM work and could remain stale
// after a repair pass. Image-specific terminal errors continue to use the
// existing IMAGE_ERROR path in jobs/result-delivery -> content/image-finder.
//
// Keep this module/function as a compatibility seam so the progress UI can be
// re-enabled later without changing batch ownership/state contracts.
export function publishImageStatus(_batch, _key, _item) {
  return false;
}
