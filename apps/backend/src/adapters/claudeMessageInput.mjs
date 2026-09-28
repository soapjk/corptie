import { readFile } from "node:fs/promises";

export async function makeClaudeUserMessage(text, images = []) {
  const content = [];
  for (const image of images) {
    const mediaType = claudeImageMediaType(image?.mimeType);
    const path = typeof image?.absolutePath === "string" ? image.absolutePath : "";
    if (!path) {
      const error = new Error("Claude image input requires a resolved local path.");
      error.code = "CHAT_IMAGE_MISSING";
      throw error;
    }
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: (await readFile(path)).toString("base64")
      }
    });
  }
  if (text) content.push({ type: "text", text });
  return {
    type: "user",
    message: {
      role: "user",
      content
    },
    parent_tool_use_id: null
  };
}

function claudeImageMediaType(value) {
  const type = String(value ?? "").toLowerCase();
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(type)) return type;
  const error = new Error(`Claude does not support image format ${type || "unknown"}.`);
  error.code = "CHAT_IMAGE_FORMAT_UNSUPPORTED";
  throw error;
}
