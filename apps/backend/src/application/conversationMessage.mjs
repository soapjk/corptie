import { isAbsolute } from "node:path";

export const MAX_CONVERSATION_IMAGES = 8;

export function normalizeConversationMessage(input) {
  if (typeof input === "string") return message(input, []);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidMessage("Message must be text or a structured message.");
  }
  const images = Array.isArray(input.images)
    ? input.images.map(normalizeConversationImage)
    : contentImages(input.content);
  const text = typeof input.text === "string"
    ? input.text
    : typeof input.content === "string"
      ? input.content
      : contentText(input.content);
  return message(text, images);
}

export function conversationMessageText(input) {
  return normalizeConversationMessage(input).text;
}

export function conversationMessageHasImages(input) {
  return normalizeConversationMessage(input).images.length > 0;
}

export function conversationMessageContent(input) {
  const normalized = normalizeConversationMessage(input);
  return [
    ...(normalized.text ? [{ type: "text", text: normalized.text }] : []),
    ...normalized.images.map((image) => ({ type: "image", ...image }))
  ];
}

function message(text, images) {
  const normalizedText = String(text ?? "").trim();
  if (images.length > MAX_CONVERSATION_IMAGES) {
    throw invalidMessage(`A message can contain at most ${MAX_CONVERSATION_IMAGES} images.`);
  }
  if (!normalizedText && images.length === 0) {
    throw invalidMessage("Message text or at least one image is required.");
  }
  return Object.freeze({ text: normalizedText, images: Object.freeze(images) });
}

function normalizeConversationImage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidMessage("Each message image must be an object.");
  }
  const managedPath = typeof value.managedPath === "string" ? value.managedPath.trim() : "";
  if (!managedPath || isAbsolute(managedPath) || !managedPath.startsWith("chat-resources/")) {
    throw invalidMessage("Message image managedPath must be a managed relative chat resource path.");
  }
  const originalPath = typeof value.originalPath === "string" && value.originalPath.trim()
    ? value.originalPath.trim()
    : null;
  if (originalPath && !isAbsolute(originalPath)) {
    throw invalidMessage("Message image originalPath must be absolute when present.");
  }
  return Object.freeze({ managedPath, originalPath });
}

function contentImages(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part?.type === "image").map(normalizeConversationImage);
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function invalidMessage(message) {
  const error = new Error(message);
  error.code = "INVALID_MESSAGE";
  error.statusCode = 400;
  return error;
}
