import fs from 'fs'; import path from 'path'; import os from 'os';
const REPO='/Users/jung-wankim/Project/Claude/memory-bank';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mb-r16-'));
process.env.MEMORY_BANK_DB_PATH=path.join(tmp,'db.sqlite');
const { initDatabase, insertExchange } = await import(REPO+'/dist/db.js');
const { searchConversations } = await import(REPO+'/dist/search.js');
const db=initDatabase();
const emb=Array(384).fill(0.03);
const mk=(id,msg,ts)=>({id,project:'t',timestamp:ts||new Date().toISOString(),userMessage:msg,assistantMessage:'x',archivePath:'/tmp/y.jsonl',lineStart:1,lineEnd:2});
let pass=0,fail=0; const check=(n,ok)=>{console.log((ok?'✅':'❌'),n); ok?pass++:fail++;};

// R16-1: 시간 필터가 inner LIMIT에 가려지지 않는지 — 옛 매치 1 + 새 매치 250
insertExchange(db, mk('OLD1','needle commonterm ancient doc','2020-06-01T00:00:00Z'), emb);
for (let i=0;i<250;i++) insertExchange(db, mk('NEW'+i,'needle commonterm modern doc '+i,'2025-01-01T00:00:00Z'), emb);
const r1 = await searchConversations('needle commonterm', { limit:5, mode:'text', before:'2021-01-01' });
check(`R16-1: before 필터로 옛 매치 검색 (${r1.length}건, OLD1 ${r1.some(r=>r.exchange.id==='OLD1')?'포함':'누락'})`,
  r1.length===1 && r1[0].exchange.id==='OLD1');

// R16-2: 사다리 — rare 방해물이 common 타깃을 억제하지 않는지
insertExchange(db, mk('TARGET','commonword only doc here'), emb);
insertExchange(db, mk('DISTRACTOR','raretoken only doc here'), emb);
for (let i=0;i<3;i++) insertExchange(db, mk('CW'+i,'commonword filler '+i), emb);
const r2 = await searchConversations('raretoken commonword', { limit:10, mode:'text' });
const ids = r2.map(r=>r.exchange.id);
check(`R16-2: rare(DISTRACTOR)+common(TARGET) 모두 반환 (${ids.join(',')})`,
  ids.includes('DISTRACTOR') && ids.includes('TARGET'));
// R18: rare 방해물 10개가 limit 슬롯을 독점해 common 타깃을 밀어내지 않는지
for (let i=0;i<10;i++) insertExchange(db, mk('RARE'+i,'raretoken2 crowd doc '+i), emb);
insertExchange(db, mk('TARGET2','commonword2 only target doc'), emb);
for (let i=0;i<3;i++) insertExchange(db, mk('CW2'+i,'commonword2 filler '+i), emb);
const r3 = await searchConversations('raretoken2 commonword2', { limit:5, mode:'text' });
const ids3 = r3.map(r=>r.exchange.id);
check(`R18: rare 10개 crowd 속 common 타깃 포함 (${ids3.join(',')})`,
  ids3.includes('TARGET2') || ids3.some(i=>i.startsWith('CW2')));
db.close(); fs.rmSync(tmp,{recursive:true,force:true});
console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
