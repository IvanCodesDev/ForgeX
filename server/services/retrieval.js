/* 知识检索（RAG 的 R）—— 从已登记的知识文档里挑出与问题相关的片段。

   实现选择：**BM25 关键词检索**，不是向量检索。

   为什么不上 embedding：
     1. 本项目承诺零运行时依赖，而像样的本地 embedding 模型是几十上百 MB 的依赖；
     2. 调用远程 embedding API 会引入第二个必须配置的密钥，抬高上手门槛；
     3. 本场景的知识库是**术语表 / 材料参数 / 设备手册**——查询词与文档词高度重合
        （用户问「翘边」，术语表里就写着「翘边」），BM25 在这种词面匹配场景下
        本就接近甚至优于稠密检索。
   把它换成向量检索是将来的事，但那应该由真实的检索质量问题驱动，而不是因为时髦。

   中文分词：不引入分词器，改用 **字符二元组（bigram）**。
   中文里「翘边」「回抽」这类术语都是双字，bigram 足以覆盖；
   英文与数字按空白/标点切词。这是在零依赖约束下的合理取舍，效果可测（见 tests）。 */
"use strict";

const K1 = 1.5; // BM25 词频饱和参数（经验值）
const B = 0.75; // BM25 文档长度归一化参数（经验值）

/** 文本 → 词元。中文取字符 bigram，英文/数字按词切分。 */
function tokenize(text) {
  const s = String(text || "").toLowerCase();
  const out = [];
  // 英文单词与数字
  const words = s.match(/[a-z0-9][a-z0-9._-]*/g);
  if (words) out.push(...words);
  // 中文（含全角）字符序列 → bigram；单字成段时保留单字
  const cjkRuns = s.match(/[一-鿿㐀-䶿]+/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      if (run.length === 1) { out.push(run); continue; }
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

/** 把长文档切成可检索的片段：按空行/标题分段，过长的再按句号切。 */
function chunk(text, maxLen) {
  const limit = maxLen || 400;
  const paras = String(text || "")
    .split(/\n\s*\n|\n(?=#)/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [];
  for (const p of paras) {
    if (p.length <= limit) { out.push(p); continue; }
    let buf = "";
    for (const sent of p.split(/(?<=[。！？；;.!?])/)) {
      if (buf.length + sent.length > limit && buf) { out.push(buf.trim()); buf = ""; }
      buf += sent;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

/**
 * 构建 BM25 索引。文档数在本项目里是几十量级，直接全量扫描即可，
 * 不需要倒排表——过早优化只会让代码难读。
 */
function buildIndex(docs) {
  const entries = [];
  for (const doc of docs) {
    for (const [i, text] of chunk(doc.text).entries()) {
      const toks = tokenize(text);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      entries.push({ docId: doc.id, docName: doc.name, chunkIndex: i, text, tf, len: toks.length });
    }
  }
  const avgLen = entries.length ? entries.reduce((a, e) => a + e.len, 0) / entries.length : 0;
  // 文档频率
  const df = new Map();
  for (const e of entries) for (const t of e.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  return { entries, avgLen, df, N: entries.length };
}

/** 覆盖率在总分中的权重。见 search() 里对小语料退化问题的说明。 */
const COVERAGE_WEIGHT = 2;
/** 命中阈值。低于此值视为不相关，宁可不返回。 */
const SCORE_FLOOR = 0.35;

/**
 * 检索 top-k 相关片段。
 *
 * 总分 = BM25 + 覆盖率 × 权重。为什么要加覆盖率这一项：
 * BM25 的 IDF 在**小语料下会退化**——语料里只有一两个片段时，
 * 每个词的文档频率都等于总数，IDF 趋近 0，于是「用户刚上传的第一份文档」
 * 无论问什么都检索不到。这不是理论问题，是本项目的默认使用路径。
 * 覆盖率（问题词元有多大比例出现在该片段中）与语料规模无关，正好补上这个洞。
 *
 * @returns {Array<{docName, text, score}>} 按相关度降序；无命中返回空数组（不硬凑）
 */
function search(index, query, k, minScore) {
  if (!index || !index.N) return [];
  const topK = k == null ? 4 : k;
  const floor = minScore == null ? SCORE_FLOOR : minScore;
  const qToks = [...new Set(tokenize(query))];
  if (!qToks.length) return [];

  const scored = index.entries.map((e) => {
    let bm25 = 0;
    let matched = 0;
    for (const t of qToks) {
      const f = e.tf.get(t);
      if (!f) continue;
      matched++;
      const n = index.df.get(t) || 0;
      // BM25 的 IDF（加 0.5 平滑，避免高频词出现负权重）
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      const norm = (f * (K1 + 1)) / (f + K1 * (1 - B + (B * e.len) / (index.avgLen || 1)));
      bm25 += idf * norm;
    }
    const coverage = matched / qToks.length;
    return {
      docName: e.docName, text: e.text, matched: matched,
      score: matched ? bm25 + coverage * COVERAGE_WEIGHT : 0,
    };
  });

  return scored
    // 一个词元都没匹配上就是不相关：塞无关片段进 prompt 只会干扰模型
    .filter((x) => x.matched > 0 && x.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 便捷入口：给定文档集与问题，返回可直接注入 prompt 的知识片段。
 * 检索不到就返回空数组——**宁可不给，也不给无关内容**。
 */
function retrieve(docs, question, opt) {
  opt = opt || {};
  if (!docs || !docs.length) return [];
  const idx = buildIndex(docs);
  const hits = search(idx, question, opt.topK, opt.minScore);
  return hits.map((h) => ({
    name: h.docName,
    text: h.text,
    score: Math.round(h.score * 1000) / 1000,
  }));
}

module.exports = { tokenize, chunk, buildIndex, search, retrieve };
