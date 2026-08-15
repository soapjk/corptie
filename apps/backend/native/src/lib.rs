#[macro_use]
extern crate napi_derive;

/// 计算两个字符串的 Levenshtein 编辑距离（按 Unicode 字符计）。
///
/// 验证用途：Phase 0 技术栈地基 —— 证明 Rust 能在 Corptie 的 JS 栈里被调用。
/// 后续用途：`13` 记忆去重的底层相似度件。
#[napi]
pub fn levenshtein_distance(a: String, b: String) -> u32 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        return m as u32;
    }
    if m == 0 {
        return n as u32;
    }
    // 滚动数组，只保留上一行，避免 O(n*m) 内存
    let mut prev: Vec<u32> = (0..=m as u32).collect();
    let mut curr: Vec<u32> = vec![0; m + 1];
    for i in 1..=n {
        curr[0] = i as u32;
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[m]
}
