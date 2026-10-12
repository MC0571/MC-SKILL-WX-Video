const encoder = new TextEncoder();

export function safeDownloadFilename(title, date = new Date()) {
  const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  let name = String(title ?? "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, "_")
    .replace(/\.{2,}/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "");
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) name = "视频号";

  const suffix = `_${datePart}.mp4`;
  const maxTitleBytes = 255 - encoder.encode(suffix).byteLength - 16;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let shortName = "";
  for (const { segment } of segmenter.segment(name)) {
    if (encoder.encode(shortName + segment).byteLength > maxTitleBytes) break;
    shortName += segment;
  }
  return `${shortName.trimEnd() || "视频号"}${suffix}`;
}

export function isSafeRelativeMp4Filename(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.toLowerCase().endsWith(".mp4") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f<>:"|?*]/.test(value)
  ) return false;

  const parts = value.split("/");
  return parts.every((part) => {
    if (!part || part === "." || part === "..") return false;
    return encoder.encode(part).byteLength <= 255;
  });
}
