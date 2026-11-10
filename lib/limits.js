// Limits shared by the browser (instant feedback) and the API (enforcement).

export const DESCRIPTION_WORD_LIMIT = 1000;
// Generous character ceiling so 1,000 long words still fit, while bounding stored size.
export const DESCRIPTION_CHAR_LIMIT = 10000;
export const wordCount = (text) => (String(text || "").trim().match(/\S+/g) || []).length;
export const descriptionError = (text) => {
  const value = String(text || "");
  if (wordCount(value) > DESCRIPTION_WORD_LIMIT) return `Description must be ${DESCRIPTION_WORD_LIMIT} words or fewer (currently ${wordCount(value)}).`;
  if (value.length > DESCRIPTION_CHAR_LIMIT) return `Description must be ${DESCRIPTION_CHAR_LIMIT.toLocaleString("en-GB")} characters or fewer.`;
  return "";
};

// Attachments: only these image and document formats are accepted, each with its own size cap.
// SVG and HTML are deliberately excluded because they can carry scripts.
const MB = 1024 * 1024;
export const ATTACHMENT_RULES = {
  image: { label: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"], maxBytes: 2 * MB },
  document: { label: "Documents", extensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv"], maxBytes: 4 * MB },
};
export const ATTACHMENT_ACCEPT = Object.values(ATTACHMENT_RULES).flatMap((rule) => rule.extensions.map((ext) => "." + ext)).join(",");
export const ATTACHMENT_HINT = Object.values(ATTACHMENT_RULES)
  .map((rule) => `${rule.label} (${rule.extensions.map((ext) => ext.toUpperCase()).join(", ")}) up to ${rule.maxBytes / MB} MB`)
  .join(" · ");
const extensionOf = (name) => (String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "");
export const attachmentKind = (name) => Object.keys(ATTACHMENT_RULES).find((kind) => ATTACHMENT_RULES[kind].extensions.includes(extensionOf(name))) || "";
// Returns "" when the file is allowed, otherwise a message for the user.
export const attachmentError = (file) => {
  const name = file?.name || "";
  const kind = attachmentKind(name);
  if (!kind) return `"${name || "File"}" is not an allowed format. Allowed: ${ATTACHMENT_HINT}.`;
  const rule = ATTACHMENT_RULES[kind];
  if (!file.size) return `"${name}" is empty.`;
  if (file.size > rule.maxBytes) return `"${name}" is ${(file.size / MB).toFixed(1)} MB. ${rule.label} must be ${rule.maxBytes / MB} MB or smaller; use Add link for bigger files.`;
  // A browser-declared type that contradicts the extension (e.g. an executable renamed to .png) is refused.
  const type = String(file.type || "").toLowerCase();
  if (kind === "image" && type && !type.startsWith("image/")) return `"${name}" does not look like an image file.`;
  if (kind === "document" && (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/") || /javascript|html|x-msdownload|x-sh/.test(type))) return `"${name}" does not look like a document file.`;
  return "";
};
