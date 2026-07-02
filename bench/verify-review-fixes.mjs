#!/usr/bin/env node
// Codex 적대 리뷰 3건 수정의 exploit-재현 검증
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs'; import path from 'path'; import os from 'os';
import { execFileSync } from 'child_process';
const REPO = '/Users/jung-wankim/Project/Claude/memory-bank';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fix-'));
let pass = 0, fail = 0;
const check = (name, ok) => { console.log((ok?'✅':'❌'), name); ok?pass++:fail++; };

// === Fix3 (MEDIUM): dtype는 sqlite_master 실스키마에서 파생 ===
{
  process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 'dtype.sqlite');
  const { initDatabase, getVecDtype } = await import(REPO + '/dist/db.js');
  const db = initDatabase(); // fresh → int8
  check('fresh DB → int8 (flag 없이 스키마 파생)', getVecDtype(db) === 'int8');
  db.close();
  // 레거시 float 테이블 시뮬레이션
  const p2 = path.join(tmp, 'legacy.sqlite');
  const raw = new Database(p2); sqliteVec.load(raw);
  raw.exec('CREATE VIRTUAL TABLE vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])');
  raw.close();
  process.env.MEMORY_BANK_DB_PATH = p2;
  const db2 = initDatabase(); // 기존 float 테이블 → IF NOT EXISTS 스킵
  check('레거시 float 테이블 → float32 감지 (스키마 보존)', getVecDtype(db2) === 'float32');
  db2.close();
}

// === Fix2 (HIGH): 연결 캐시가 파일 교체를 감지 ===
{
  const p = path.join(tmp, 'cache.sqlite');
  process.env.MEMORY_BANK_DB_PATH = p;
  const { searchConversations } = await import(REPO + '/dist/search.js');
  const { initDatabase, insertExchange } = await import(REPO + '/dist/db.js');
  const mk = (id, msg) => ({ id, project:'t', timestamp:new Date().toISOString(), userMessage:msg, assistantMessage:'a', archivePath:'/tmp/x.jsonl', lineStart:1, lineEnd:2 });
  const emb = Array(384).fill(0.05);
  let db = initDatabase(); insertExchange(db, mk('old1','OLDROW unique marker'), emb); db.close();
  const r1 = await searchConversations('OLDROW', { limit: 5, mode: 'text' });
  // 파일 교체 (unlink + 재생성, 다른 내용)
  fs.unlinkSync(p); try{fs.unlinkSync(p+'-wal')}catch{} try{fs.unlinkSync(p+'-shm')}catch{}
  db = initDatabase(); insertExchange(db, mk('new1','NEWROW unique marker'), emb); db.close();
  const r2old = await searchConversations('OLDROW', { limit: 5, mode: 'text' });
  const r2new = await searchConversations('NEWROW', { limit: 5, mode: 'text' });
  check('교체 전 검색 동작', r1.length === 1);
  check('파일 교체 후 삭제행 미반환 (stale 핸들 아님)', r2old.length === 0);
  check('파일 교체 후 신규행 검색됨', r2new.length === 1);
}

// === Fix1 (CRITICAL): 마이그레이션 중 유입된 행의 벡터 보존 ===
{
  const p = path.join(tmp, 'migr.sqlite');
  const raw = new Database(p); sqliteVec.load(raw);
  raw.exec('CREATE VIRTUAL TABLE vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])');
  raw.exec('CREATE TABLE fts_meta (key TEXT PRIMARY KEY, value TEXT)');
  const ins = raw.prepare('INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)');
  const femb = (v) => Buffer.from(new Float32Array(Array(384).fill(v)).buffer);
  for (let i = 0; i < 10; i++) ins.run('row'+i, femb(0.01*i));
  raw.close();
  // 실제 스크립트 실행 + 스크래치 빌드와 스왑 사이에 '동시 쓰기' 주입
  const inject = `INSERT INTO vec_exchanges(id, embedding) SELECT 'raced-row', embedding FROM vec_exchanges LIMIT 1; DELETE FROM vec_exchanges WHERE id='row3';`;
  const out = execFileSync('node', [REPO + '/scripts/migrate-vec-int8.mjs', '--db', p], {
    env: { ...process.env, MIGRATE_TEST_INJECT_SQL: inject }, encoding: 'utf-8'
  });
  const v = new Database(p); sqliteVec.load(v);
  const ids = v.prepare('SELECT id FROM vec_exchanges').all().map(r=>r.id);
  const sql = v.prepare(`SELECT sql FROM sqlite_master WHERE name='vec_exchanges'`).get().sql;
  check('마이그레이션 성공 (int8 스키마)', /int8\s*\[/i.test(sql));
  check('레이스 유입 행 보존 (raced-row)', ids.includes('raced-row'));
  check('레이스 삭제 행 제거 반영 (row3 없음)', !ids.includes('row3'));
  check('행 수 정합 (10 -1 +1 = 10)', ids.length === 10);
  console.log(out.split('\n').filter(l=>l.includes('delta')).join('\n'));
  v.close();
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
