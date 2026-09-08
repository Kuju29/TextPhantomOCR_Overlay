import { createLogger } from "../../shared/logger.js";
import { API_PATHS } from "../../shared/constants.js";
import { getApiBase, noteApiSuccess } from "../api.js";
import { limitHeaders } from "./http-error.js";

const log = createLogger("SW.transport.cancel");
export async function cancelJobsViaRest({
  jobIds = [],
  batchId = "",
  session = "",
} = {}) {
  const ids = (Array.isArray(jobIds) ? jobIds : []).map(String).filter(Boolean);
  if (!ids.length && !batchId && !session) return;
  try {
    const base = await getApiBase();
    if (!base) return;
    const response = await fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE_CANCEL, {
      method: "POST",
      // Cancellation is control traffic, not paced work. Keep the policy
      // explicit and request-local rather than inheriting it from another job.
      headers: limitHeaders(base, false, {
        "Content-Type": "application/json",
      }),
      cache: "no-store",
      keepalive: true,
      body: JSON.stringify({
        job_ids: ids,
        batch_id: batchId,
        tp_tab_session: session,
      }),
    });
    if (response.ok) noteApiSuccess(base);
  } catch (e) {
    log.debug?.("cancel post failed", e?.message || String(e));
  }
}
