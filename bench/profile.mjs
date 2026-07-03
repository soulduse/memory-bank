// searchConversations 내부 비용 분해 프로파일
process.env.MEMORY_BANK_DB_PATH='/Users/jung-wankim/Project/Claude/memory-bank/.autoresearch/bench-db.sqlite';
import fs from 'fs';
import { performance } from 'perf_hooks';
const REPO='/Users/jung-wankim/Project/Claude/memory-bank';
const { initDatabase } = await import(REPO+'/dist/db.js');
const { initEmbeddings, generateEmbedding } = await import(REPO+'/dist/embeddings.js');
await initEmbeddings();
await generateEmbedding('warmup', 'query');

const N=30;
// 1) initDatabase 비용
let t=performance.now();
for(let i=0;i<N;i++){ const db=initDatabase(); db.close(); }
console.log('initDatabase+close avg ms:', ((performance.now()-t)/N).toFixed(2));

// 2) 쿼리 임베딩 비용
const qs = JSON.parse(fs.readFileSync(REPO+'/.autoresearch/queries.json','utf8')).slice(0,N);
t=performance.now();
for(const q of qs) await generateEmbedding(q.query,'query');
console.log('generateEmbedding avg ms:', ((performance.now()-t)/N).toFixed(2));

// 3) vec KNN 비용 (임베딩 재사용)
const db=initDatabase();
const emb = await generateEmbedding(qs[0].query,'query');
const buf = Buffer.from(new Float32Array(emb).buffer);
const { EMBEDDING_VERSION } = await import(REPO+'/dist/embeddings.js');
const stmt=db.prepare(`SELECT e.id, vec.distance FROM vec_exchanges vec JOIN exchanges e ON vec.id=e.id WHERE vec.embedding MATCH ? AND k = ? AND e.embedding_version = ? ORDER BY vec.distance`);
t=performance.now();
for(let i=0;i<N;i++) stmt.all(buf, 10, EMBEDDING_VERSION);
console.log('vec KNN(k=10) avg ms:', ((performance.now()-t)/N).toFixed(2));

// 4) FTS 비용
const fts=db.prepare(`SELECT e.id FROM exchanges_fts f JOIN exchanges e ON e.rowid=f.rowid WHERE exchanges_fts MATCH ? ORDER BY rank LIMIT 10`);
t=performance.now(); let ftsHits=0;
for(const q of qs){ const expr=q.query.split(/\s+/).map(x=>x.replace(/"/g,'')).filter(Boolean).map(x=>`"${x}"`).join(' '); try{ ftsHits+=fts.all(expr).length; }catch{} }
console.log('FTS avg ms:', ((performance.now()-t)/N).toFixed(2), '— 총 히트:', ftsHits, '/', N*10, '(AND 시맨틱 장문 쿼리 매치율)');
db.close();
