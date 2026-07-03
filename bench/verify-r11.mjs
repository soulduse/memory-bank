import fs from 'fs'; import path from 'path'; import os from 'os';
const REPO='/Users/jung-wankim/Project/Claude/memory-bank';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mb-r11-'));
process.env.MEMORY_BANK_DB_PATH=path.join(tmp,'db.sqlite');
const { initDatabase, insertExchange } = await import(REPO+'/dist/db.js');
const { searchConversations } = await import(REPO+'/dist/search.js');
const db=initDatabase();
const emb=Array(384).fill(0.03);
const mk=(id,msg)=>({id,project:'t',timestamp:new Date().toISOString(),userMessage:msg,assistantMessage:'x',archivePath:'/tmp/y.jsonl',lineStart:1,lineEnd:2});
// 타깃: 짧은 식별자만 포함 (긴 boilerplate 토큰 없음) — AND 불가, 기존 6-longest OR도 불가
insertExchange(db, mk('TGT','issue id7 QA partial context'), emb);
// 방해물: 긴 boilerplate 6+개
for (let i=0;i<6;i++) insertExchange(db, mk('D'+i,'longwordalpha longwordbeta longwordgamma longworddelta longwordepsilon longwordzeta'), emb);
db.close();
const q='longwordalpha longwordbeta longwordgamma longworddelta longwordepsilon longwordzeta id7 QA';
const res = await searchConversations(q, {limit:10, mode:'text'});
const hit = res.some(r=>r.exchange.id==='TGT');
console.log((hit?'✅':'❌'), 'R11-2: 짧은 식별자(id7/QA) 타깃이 OR 셋에 포함되어 검색됨 —', res.map(r=>r.exchange.id).join(','));
fs.rmSync(tmp,{recursive:true,force:true});
process.exit(hit?0:1);
