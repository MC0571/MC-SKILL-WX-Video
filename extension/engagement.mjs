import { LINKS } from "./config.mjs";
import { getInstallSource } from "./update-state.mjs";

export const FIRST_OPEN_GUIDE_KEY = "weixin-channels-video:first-open-guide-shown";
export const FIRST_SUCCESSFUL_PARSE_KEY = "weixin-channels-video:first-successful-parse-at";
export const REVIEW_PROMPT_HANDLED_KEY = "weixin-channels-video:review-prompt-handled";

export async function recordSuccessfulParse(chromeApi = globalThis.chrome) {
  const storage = chromeApi?.storage?.local;
  if (typeof storage?.get !== "function" || typeof storage?.set !== "function") return false;

  const stored = await storage.get(FIRST_SUCCESSFUL_PARSE_KEY);
  if (Number.isFinite(stored?.[FIRST_SUCCESSFUL_PARSE_KEY])) return false;
  await storage.set({ [FIRST_SUCCESSFUL_PARSE_KEY]: Date.now() });
  return true;
}

export function initializeEngagementUi({
  chromeApi = globalThis.chrome,
  documentApi = globalThis.document,
  windowApi = globalThis,
} = {}) {
  if (!documentApi?.querySelector) return null;

  const repositoryLink = documentApi.querySelector("#repository-link");
  const guideRepositoryLink = documentApi.querySelector("#guide-repository-link");
  const privacyLink = documentApi.querySelector("#privacy-link");
  const feedbackLink = documentApi.querySelector("#feedback-link");
  if (repositoryLink) repositoryLink.href = LINKS.repository;
  if (guideRepositoryLink) guideRepositoryLink.href = LINKS.repository;
  if (privacyLink) privacyLink.href = LINKS.privacy;
  if (feedbackLink && LINKS.feedback) feedbackLink.href = LINKS.feedback;
  if (feedbackLink && !LINKS.feedback) feedbackLink.hidden = true;

  const guide = documentApi.querySelector("#first-open-guide");
  const guideDismiss = documentApi.querySelector("#first-open-guide-dismiss");
  const reviewPrompt = documentApi.querySelector("#review-prompt");
  const reviewLink = documentApi.querySelector("#review-link");
  const reviewDismiss = documentApi.querySelector("#review-dismiss");
  if (reviewLink) reviewLink.href = LINKS.storeReview;

  const storage = chromeApi?.storage?.local;
  if (typeof storage?.get !== "function" || typeof storage?.set !== "function") return null;

  let currentState = {};
  let changedState = {};
  let storeInstall = false;
  let active = true;

  const renderReviewPrompt = () => {
    if (reviewPrompt) {
      reviewPrompt.hidden = !storeInstall ||
        !Number.isFinite(currentState[FIRST_SUCCESSFUL_PARSE_KEY]) ||
        currentState[REVIEW_PROMPT_HANDLED_KEY] === true;
    }
  };
  const markReviewHandled = async () => {
    if (reviewPrompt) reviewPrompt.hidden = true;
    currentState[REVIEW_PROMPT_HANDLED_KEY] = true;
    changedState[REVIEW_PROMPT_HANDLED_KEY] = true;
    try {
      await storage.set({ [REVIEW_PROMPT_HANDLED_KEY]: true });
    } catch {
      // Keep this page's choice in effect if profile storage is unavailable.
    }
  };

  guideDismiss?.addEventListener("click", () => {
    if (guide) guide.hidden = true;
  });
  reviewLink?.addEventListener("click", () => {
    windowApi?.setTimeout?.(() => { void markReviewHandled(); }, 0);
  });
  reviewDismiss?.addEventListener("click", () => { void markReviewHandled(); });

  const onStorageChanged = (changes, areaName) => {
    if (areaName !== "local" || !active) return;
    if (Object.hasOwn(changes ?? {}, FIRST_SUCCESSFUL_PARSE_KEY)) {
      const value = changes[FIRST_SUCCESSFUL_PARSE_KEY].newValue;
      currentState[FIRST_SUCCESSFUL_PARSE_KEY] = value;
      changedState[FIRST_SUCCESSFUL_PARSE_KEY] = value;
      renderReviewPrompt();
    }
    if (Object.hasOwn(changes ?? {}, REVIEW_PROMPT_HANDLED_KEY)) {
      const value = changes[REVIEW_PROMPT_HANDLED_KEY].newValue;
      currentState[REVIEW_PROMPT_HANDLED_KEY] = value;
      changedState[REVIEW_PROMPT_HANDLED_KEY] = value;
      renderReviewPrompt();
    }
  };
  chromeApi?.storage?.onChanged?.addListener(onStorageChanged);
  windowApi?.addEventListener?.("pagehide", () => {
    active = false;
    chromeApi?.storage?.onChanged?.removeListener?.(onStorageChanged);
  }, { once: true });

  void Promise.all([
    getInstallSource(chromeApi),
    storage.get([FIRST_OPEN_GUIDE_KEY, FIRST_SUCCESSFUL_PARSE_KEY, REVIEW_PROMPT_HANDLED_KEY]),
  ]).then(([source, stored]) => {
    if (!active) return;
    currentState = { ...stored, ...changedState };
    storeInstall = source === "store";
    if (guide && currentState[FIRST_OPEN_GUIDE_KEY] !== true) {
      guide.hidden = false;
      currentState[FIRST_OPEN_GUIDE_KEY] = true;
      void storage.set({ [FIRST_OPEN_GUIDE_KEY]: true }).catch(() => {});
    }
    renderReviewPrompt();
  }).catch(() => {
    if (reviewPrompt) reviewPrompt.hidden = true;
  });

}
