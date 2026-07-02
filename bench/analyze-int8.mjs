#!/usr/bin/env node
// int8 양자화 POC: bench DB의 float32 벡터를 int8로 변환한 스크래치 테이블을 만들고
// 동일 100쿼리로 vector-only recall@10과 KNN latency, 저장 크기를 float와 비교.
// (운영 마이그레이션 의사결정용 증거 — src 변경 없음)
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
const REPO = '/Users/jung-wankim/Project/Claude/memory-bank';
process.env.MEMORY_BANK_DB_PATH = path.join(REPO, '.autoresearch/bench-db.sqlite');
const { initEmbeddings, generateEmbedding, EMBEDDING_VERSION } = await import(REPO + '/dist/embeddings.js');
await initEmbeddings();

const db = new Database(path.join(REPO, '.autoresearch/bench-db.sqlite'));
sqliteVec.load(db);

// 1) int8 스크래치 테이블 생성 (없으면)
const exists = db.prepare("SELECT name FROM sqlite_master WHERE name='vec_exchanges_i8_chunks'").get();
if (!exists) {
  db.exec("CREATE VIRTUAL TABLE vec_exchanges_i8 USING vec0(id TEXT PRIMARY KEY, embedding int8[384])");
  const ins = db.prepare('INSERT INTO vec_exchanges_i8 (id, embedding) VALUES (?, vec_int8(?))');
  const q = (f32) => { const a = new Int8Array(384); for (let i=0;i<384;i++) a[i]=Math.max(-127,Math.min(127,Math.round(f32[i]*127))); return Buffer.from(a.buffer); };
  // separate read connection: iterate + insert on one connection => "busy"
  const rdb = new Database(path.join(REPO, '.autoresearch/bench-db.sqlite'), { readonly: true });
  sqliteVec.load(rdb);
  let n = 0;
  const tx = db.transaction((rows) => { for (const [id, buf] of rows) ins.run(id, buf); });
  let batch = [];
  for (const r of rdb.prepare('SELECT id, embedding FROM vec_exchanges').iterate()) {
    batch.push([r.id, q(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 384))]);
    if (batch.length >= 2000) { tx(batch); n += batch.length; batch = []; }
  }
  if (batch.length) { tx(batch); n += batch.length; }
  rdb.close();
  console.log('int8 rows:', n);
}

// 2) recall + latency 비교 (vector-only)
const qs = JSON.parse(fs.readFileSync(path.join(REPO, '.autoresearch/queries.json'), 'utf8')).slice(0, 100);
const pfxOf = new Map(qs.map(x => [x.id, x.pfx]));
const f32Stmt = db.prepare(`SELECT e.id, substr(e.user_message,1,80) um FROM vec_exchanges v JOIN exchanges e ON v.id=e.id WHERE v.embedding MATCH ? AND k=10 AND e.embedding_version=? ORDER BY v.distance`);
const i8Stmt  = db.prepare(`SELECT e.id, substr(e.user_message,1,80) um FROM vec_exchanges_i8 v JOIN exchanges e ON v.id=e.id WHERE v.embedding MATCH vec_int8(?) AND k=10 AND e.embedding_version=? ORDER BY v.distance`);

let f32Hits=0, i8Hits=0, agree=0; const f32Lat=[], i8Lat=[];
for (const { id, pfx, query } of qs) {
  const emb = await generateEmbedding(query, 'query');
  const fbuf = Buffer.from(new Float32Array(emb).buffer);
  const a = new Int8Array(384); for (let i=0;i<384;i++) a[i]=Math.max(-127,Math.min(127,Math.round(emb[i]*127)));
  const ibuf = Buffer.from(a.buffer);
  let t=performance.now(); const rf=f32Stmt.all(fbuf,EMBEDDING_VERSION); f32Lat.push(performance.now()-t);
  t=performance.now(); const ri=i8Stmt.all(ibuf,EMBEDDING_VERSION); i8Lat.push(performance.now()-t);
  const hit=(rs)=>rs.some(r=>r.id===id||(pfx&&r.um.startsWith(pfx.slice(0,80))));
  if (hit(rf)) f32Hits++; if (hit(ri)) i8Hits++;
  if (rf[0]?.id===ri[0]?.id) agree++;
}
f32Lat.sort((a,b)=>a-b); i8Lat.sort((a,b)=>a-b);
const med=(a)=>a[Math.floor(a.length/2)].toFixed(2);
// 3) 저장 크기
const sz = db.prepare("SELECT name, SUM(pgsize) s FROM dbstat WHERE name LIKE 'vec_exchanges%chunks00' GROUP BY name").all();
for (const r of sz) console.log(r.name, (r.s/1048576).toFixed(1)+'MB');
console.log(`float32: recall ${f32Hits}/100, KNN p50 ${med(f32Lat)}ms`);
console.log(`int8   : recall ${i8Hits}/100, KNN p50 ${med(i8Lat)}ms`);
console.log(`top-1 일치율: ${agree}/100`);
db.close();
