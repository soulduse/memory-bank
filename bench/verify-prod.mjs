process.env.MEMORY_BANK_DB_PATH = process.env.HOME + '/.config/superpowers/conversation-index/db.sqlite';
import { performance } from 'perf_hooks';
const { searchConversations } = await import('/Users/jung-wankim/Project/Claude/memory-bank/dist/search.js');
// 텍스트 검색 (FTS 경로 — 이전엔 456K행 LIKE 풀스캔)
let t = performance.now();
const rt = await searchConversations('sqlite-vec 마이그레이션', { limit: 5, mode: 'text' });
console.log(`text 검색: ${(performance.now()-t).toFixed(0)}ms, ${rt.length}건`);
// 벡터 검색 (아직 float32)
t = performance.now();
const rv = await searchConversations('int8 양자화 벡터 검색 최적화', { limit: 5, mode: 'vector' });
console.log(`vector 검색: ${(performance.now()-t).toFixed(0)}ms, ${rv.length}건, top sim ${rv[0]?.similarity?.toFixed(3)}`);
