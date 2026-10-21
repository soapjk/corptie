// Retrieval-only stopwords. Keep source text, model evidence and embeddings intact.
// Replace with boundaries so removing a word never creates a new Chinese bigram.
const CHINESE_STOPWORDS = [
  "用户", "我们", "你们", "他们", "自己", "这个", "那个", "这些", "那些",
  "一个", "一些", "这种", "那种", "这样", "那样", "当前", "现在", "目前",
  "相关", "关于", "进行", "可以", "需要", "希望", "要求", "已经", "然后", "以及"
];
const ENGLISH_STOPWORDS = [
  "user", "users", "the", "a", "an", "and", "or", "of", "to", "in", "on",
  "for", "with", "is", "are", "be", "this", "that", "please"
];
const chinesePattern = new RegExp(CHINESE_STOPWORDS.join("|"), "g");
const englishPattern = new RegExp(`\\b(?:${ENGLISH_STOPWORDS.join("|")})\\b`, "g");

export function normalizeMemoryLexicalText(value) {
  return String(value ?? "").toLowerCase()
    .replace(chinesePattern, " ")
    .replace(englishPattern, " ")
    .replace(/\s+/g, " ").trim();
}
