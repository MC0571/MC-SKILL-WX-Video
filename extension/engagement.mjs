import { LINKS } from "./config.mjs";

export const REPOSITORY_LINK_CLICKED_KEY = "weixin-channels-video:repository-link-clicked";
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
  const repositoryLabel = documentApi.querySelector("#repository-link-label");
  const privacyLink = documentApi.querySelector("#privacy-link");
  const feedbackLink = documentApi.querySelector("#feedback-link");
  if (repositoryLink) repositoryLink.href = LINKS.repository;
  if (privacyLink) privacyLink.href = LINKS.privacy;
  if (feedbackLink && LINKS.feedback) feedbackLink.href = LINKS.feedback;
  if (feedbackLink && !LINKS.feedback) feedbackLink.hidden = true;

  const reviewPrompt = documentApi.querySelector("#review-prompt");
  const reviewLink = documentApi.querySelector("#review-link");
  const reviewDismiss = documentApi.querySelector("#review-dismiss");
  if (reviewLink) reviewLink.href = LINKS.storeReview;

  const storage = chromeApi?.storage?.local;
  if (typeof storage?.get !== "function" || typeof storage?.set !== "function") return null;

  let currentState = {};
  let changedState = {};
  let stateLoaded = false;
  let active = true;

  const renderRepositoryLink = () => {
    const clicked = currentState[REPOSITORY_LINK_CLICKED_KEY] === true;
    if (repositoryLabel) repositoryLabel.textContent = clicked ? "Github" : "Star 一下";
    if (repositoryLink) {
      if (stateLoaded && !clicked) repositoryLink.dataset.starNudge = "true";
      else delete repositoryLink.dataset.starNudge;
    }
  };
  const markRepositoryClicked = async () => {
    currentState[REPOSITORY_LINK_CLICKED_KEY] = true;
    changedState[REPOSITORY_LINK_CLICKED_KEY] = true;
    renderRepositoryLink();
    try {
      await storage.set({ [REPOSITORY_LINK_CLICKED_KEY]: true });
    } catch {
      // Keep the clicked state on this page if profile storage is unavailable.
    }
  };
  repositoryLink?.addEventListener("click", markRepositoryClicked);
  repositoryLink?.addEventListener("auxclick", (event) => {
    if (event.button === 1) return markRepositoryClicked();
  });

  const renderReviewPrompt = () => {
    if (reviewPrompt) {
      reviewPrompt.hidden = !stateLoaded ||
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

  reviewLink?.addEventListener("click", () => {
    windowApi?.setTimeout?.(() => { void markReviewHandled(); }, 0);
  });
  reviewDismiss?.addEventListener("click", () => { void markReviewHandled(); });

  const onStorageChanged = (changes, areaName) => {
    if (areaName !== "local" || !active) return;
    if (Object.hasOwn(changes ?? {}, REPOSITORY_LINK_CLICKED_KEY)) {
      const value = changes[REPOSITORY_LINK_CLICKED_KEY].newValue;
      currentState[REPOSITORY_LINK_CLICKED_KEY] = value;
      changedState[REPOSITORY_LINK_CLICKED_KEY] = value;
      renderRepositoryLink();
    }
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

  void storage.get([REPOSITORY_LINK_CLICKED_KEY, FIRST_SUCCESSFUL_PARSE_KEY, REVIEW_PROMPT_HANDLED_KEY]).then((stored) => {
    if (!active) return;
    currentState = { ...stored, ...changedState };
    stateLoaded = true;
    renderRepositoryLink();
    renderReviewPrompt();
  }).catch(() => {
    if (reviewPrompt) reviewPrompt.hidden = true;
  });

}
